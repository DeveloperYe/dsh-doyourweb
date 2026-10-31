import http from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright-core";
import { BrowserModel } from "./vendor/browser-model.js";
import { extensionId, Pairings, pinnedExtensionId } from "./pairing.js";
import { buildExtension, configFingerprint, extensionProfiles, generateManifestKey, zipDirectory } from "./extension-build.js";
import { canControl, parseRef, tabRef } from "./protocol.js";
import { managementPage } from "./manage.js";

export { extensionId } from "./pairing.js";

export function sameSecret(actual, expected) {
  const a = Buffer.from(actual || ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Shown to anything that reaches loopback without the management secret. */
function deniedPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH DoYourWeb</title>
<style>body{margin:0;padding:48px 20px;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#253b38;background:#f2f5f3}main{max-width:640px;margin:auto;background:#fff;border:1px solid #dce5df;border-radius:16px;padding:26px}h1{font-size:20px;margin:0 0 10px}code{background:#f2f6f3;border-radius:6px;padding:2px 6px}</style>
<main><h1>这个页面只能从 DSH 内部打开</h1>
<p>请回到 DSH：输入 <code>/apps</code> 打开应用管理，或输入 <code>/browser</code> 打开连接页面，链接会带着本次启动的管理密钥。</p>
<p>浏览器扩展不需要这个页面：下载好的扩展直接「加载解压的扩展」即可。</p></main></html>`;
}

export class BrowserBridge extends EventEmitter {
  constructor({ home, port = 43187, extensionSource, idleTimeoutMs = 120000, bind = "127.0.0.1", hosts = [], remote = false,
    extensionScheme = "ws", extensionPort, extensionProfiles: profiles = [], autoBuild = true } = {}) {
    super();
    this.home = home;
    this.port = port;
    this.bind = String(bind || "127.0.0.1");
    this.hosts = (Array.isArray(hosts) ? hosts : []).map(entry => String(entry).trim().toLowerCase()).filter(Boolean);
    this.remote = remote === true;
    this.extensionScheme = extensionScheme === "wss" ? "wss" : "ws";
    this.extensionPort = extensionPort;
    this.extensionProfilesConfig = Array.isArray(profiles) ? profiles : [];
    this.autoBuild = autoBuild !== false;
    this.extensionOutDir = path.join(home || ".", "extensions");
    this.extensionBuilds = [];
    this.extensionSource = extensionSource || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension");
    this.profiles = new Map();
    this.relays = new Map();
    this.pending = new Map();
    this.detachments = new Map();
    this.idleTimeoutMs = idleTimeoutMs;
    this.pairings = new Pairings();
    // The management surface is gated by a secret that is never written into any
    // HTTP response: DSH opens the page with ?k=<secret>, everything else gets an
    // explanation page. A local process can reach loopback but cannot read this.
    this.manageSecret = randomBytes(32).toString("hex");
    this.pairingFailures = 0;
    this.sequence = 0;
  }

  /** Whether the bridge listens only on this machine. */
  localBind() {
    return ["127.0.0.1", "::1", "localhost"].includes(this.bind.toLowerCase());
  }

  /**
   * Host headers this bridge answers to before any routing happens. Loopback is
   * always accepted so a local browser keeps working when the bridge is published
   * for a remote one; every additional name must be configured explicitly.
   */
  hostAllowed(header) {
    if (typeof header !== "string" || !header) return false;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim());
    if (!match) return false;
    if (match[2] !== undefined && Number(match[2]) !== this.port) return false;
    const allowed = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (!this.localBind()) allowed.add(this.bind.toLowerCase());
    for (const entry of this.hosts) allowed.add(entry);
    return allowed.has(match[1].toLowerCase());
  }

  /** A management URL carrying the per-start secret DSH hands to the browser. */
  secretUrl(pathname) {
    return `http://127.0.0.1:${this.port}${pathname}?k=${this.manageSecret}`;
  }

  manageUrl() { return this.secretUrl("/manage"); }

  setupUrl() { return this.secretUrl("/setup"); }

  /** The request already presented the management secret, in the URL or a cookie. */
  authorized(request, url) {
    const cookie = /(?:^|;\s*)dsh_manage=([0-9a-f]{32,})/.exec(request.headers.cookie || "")?.[1];
    return sameSecret(url.searchParams.get("k") ?? "", this.manageSecret)
      || sameSecret(request.headers["x-dsh-key"], this.manageSecret)
      || sameSecret(cookie, this.manageSecret);
  }

  /** Management, setup and pairing exist only for connections from this machine. */
  static loopback(request) {
    const address = request.socket?.remoteAddress;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  /**
   * The address a remote extension should use, shown on the management page.
   * Plain ws is the direct case; a TLS terminator (Cloudflare tunnel, Caddy,
   * nginx) publishes the same bridge as wss://<hostname>/extension.
   */
  endpointDescription() {
    const host = this.hosts[0] || (this.localBind() ? "127.0.0.1" : this.bind);
    return `ws://${host}:${this.port}/extension`;
  }

  /**
   * Load the pairing token and the extension identity. The companion extension is
   * loaded by the user straight from `extension/`, which pins its own manifest key,
   * so nothing is generated or copied into it; only the token lives in `home`.
   */
  async prepareExtension() {
    await mkdir(this.home, { recursive: true });
    const settingsPath = path.join(this.home, "pairing.json");
    try { this.settings = JSON.parse(await readFile(settingsPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.settings = { token: randomBytes(32).toString("hex") };
      await writeFile(settingsPath, JSON.stringify(this.settings), { mode: 0o600, flag: "wx" });
    }
    if (!/^[0-9a-f]{64}$/.test(this.settings.token ?? "")) {
      throw new Error("pairing.json has no usable token; delete it and restart the plugin to pair the extension again");
    }
    // Every installation gets its own manifest key, so the generated extension has
    // an id nobody else can claim and the stock template keeps working as a fallback.
    if (typeof this.settings.key !== "string" || !this.settings.key.length) {
      this.settings.key = generateManifestKey();
      await writeFile(settingsPath, JSON.stringify(this.settings), { mode: 0o600 });
    }
    this.extensionPath = this.extensionSource;
    this.manifest = JSON.parse(await readFile(path.join(this.extensionSource, "manifest.json"), "utf8"));
    this.id = pinnedExtensionId(this.manifest);
    this.installId = extensionId(this.settings.key);
    try { this.version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version; }
    catch { this.version = this.manifest.version; }
  }

  /** Whether a WebSocket origin may talk to this bridge at all. */
  trustedOrigin(origin) {
    return origin === `chrome-extension://${this.id}` || origin === `chrome-extension://${this.installId}`;
  }

  /** Endpoints this install can hand out as ready-made extensions. */
  extensionProfiles() {
    return extensionProfiles({ bind: this.bind, port: this.port, hosts: this.hosts,
      scheme: this.extensionScheme, publicPort: this.extensionPort, profiles: this.extensionProfilesConfig });
  }

  /**
   * Materialise one loadable extension per endpoint under `<home>/extensions`, plus
   * a zip for each so the folder can be copied to another machine. Rebuilds only
   * when the endpoint set, the token or the version changed, unless forced.
   */
  async buildExtensions({ force = false } = {}) {
    const profiles = this.extensionProfiles();
    const markerPath = path.join(this.extensionOutDir, "build.json");
    const fingerprint = configFingerprint({ profiles: profiles.map(({ key, host, port, scheme }) => ({ key, host, port, scheme })),
      token: this.settings.token, key: this.settings.key, version: this.version });
    if (!force) {
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        if (marker.fingerprint === fingerprint) { this.extensionBuilds = marker.builds; return this.extensionBuilds; }
      } catch { /* Nothing built yet. */ }
    }
    await mkdir(this.extensionOutDir, { recursive: true });
    const builds = [];
    for (const profile of profiles) {
      const dir = path.join(this.extensionOutDir, profile.key);
      const built = await buildExtension({ source: this.extensionSource, outDir: dir, profile,
        token: this.settings.token, key: this.settings.key, version: this.version });
      const zip = await zipDirectory(dir, path.join(this.extensionOutDir, `${profile.key}.zip`));
      builds.push({ key: profile.key, label: profile.label, endpoint: built.endpoint, dir, zip: zip.file,
        entries: zip.entries, bytes: zip.bytes, id: this.installId });
    }
    await writeFile(markerPath, JSON.stringify({ fingerprint, builtAt: new Date().toISOString(), builds }), { mode: 0o600 });
    this.extensionBuilds = builds;
    return builds;
  }

  /**
   * Start listening. Exposing the bridge beyond this machine is an explicit
   * decision: a non-loopback bind without `remote: true` is refused so a typo in
   * the settings cannot publish browser control to the network.
   */
  /**
   * One WebSocket upgrade. Host allowlist first, then the extension origin, then
   * either the paired token or — for a socket on this machine only — a pairing
   * request. A published bridge therefore never pairs a remote browser.
   */
  handleUpgrade(request, socket, head) {
    if (!this.hostAllowed(request.headers.host)) return socket.destroy();
    // Same rule as handleHttp: a malformed target must not throw inside an event
    // handler, where it would surface as an uncaught exception.
    let pathname;
    try { pathname = new URL(request.url, "http://127.0.0.1").pathname; }
    catch { return socket.destroy(); }
    if (pathname === "/extension") {
      const protocols = (request.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim());
      if (!this.trustedOrigin(request.headers.origin)) return socket.destroy();
      if (sameSecret(protocols[1], this.settings.token)) this.ws.handleUpgrade(request, socket, head, ws => this.acceptExtension(ws));
      else if (protocols[1] === undefined && BrowserBridge.loopback(request) && request.headers.origin === `chrome-extension://${this.id}`) {
        this.ws.handleUpgrade(request, socket, head, ws => this.acceptPairing(ws));
      } else socket.destroy();
    } else {
      const relay = this.relays.get(pathname);
      if (!relay || request.headers.origin || !sameSecret(request.headers.authorization, `Bearer ${this.settings.token}`) || relay.ws) return socket.destroy();
      this.ws.handleUpgrade(request, socket, head, ws => this.acceptCDP(relay, ws));
    }
  }

  /**
   * Start listening. Exposing the bridge beyond this machine is an explicit
   * decision: a non-loopback bind without `remote: true` is refused so a typo in
   * the settings cannot publish browser control to the network.
   */
  async start() {
    await this.prepareExtension();
    if (!this.localBind() && !this.remote) {
      throw new Error(`Refusing to listen on ${this.bind}: set "remote: true" in the plugin settings to accept browser connections from other machines, and list every hostname the extensions will use in "hosts".`);
    }
    this.server = http.createServer((request, response) => { void this.handleHttp(request, response); });
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.bind, resolve);
    }).catch(error => {
      if (error.code !== "EADDRINUSE") throw error;
      throw new Error(`Browser bridge port ${this.port} is already in use. Another DSH instance, another application, or a bridge leaked by an older plugin version owns it; stop that instance or set a different "port" in the plugin settings.`);
    });
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/setup`;
    // Ready-to-load copies for every configured endpoint. Failure here must not
    // stop the bridge: the stock folder plus PIN pairing still work without them.
    if (this.autoBuild) {
      try { await this.buildExtensions(); }
      catch (error) { this.extensionBuildError = error.message; }
    }
  }

  /** Hand the token to the extension whose pairing request the user approved. */
  approvePairing(id) {
    const pairing = this.pairings.take(id);
    if (pairing === undefined) return false;
    if (pairing.socket.readyState !== WebSocket.OPEN) return false;
    pairing.socket.send(JSON.stringify({ method: "dsh.paired", params: { token: this.settings.token, port: this.port } }));
    // The extension stores the token and reconnects authenticated, so this
    // request-only socket never becomes a control channel.
    pairing.socket.close(1000, "Paired");
    return true;
  }

  acceptPairing(ws) {
    const pairing = this.pairings.request(ws);
    if (pairing === undefined) return ws.close(1008, "Too many pairing requests");
    ws.on("error", () => {});
    const expiry = setTimeout(() => {
      this.pairings.drop(ws);
      ws.close(1000, "Pairing expired");
    }, this.pairings.ttlMs);
    expiry.unref();
    ws.on("close", () => { clearTimeout(expiry); this.pairings.drop(ws); });
    ws.send(JSON.stringify({ method: "dsh.pairing", params: {
      id: pairing.id, code: pairing.code, expiresAt: pairing.expires, port: this.port,
    } }));
  }

  async handleHttp(request, response) {
    // A malformed request target must never escape as an unhandled rejection: Node
    // would terminate the whole DSH process on one bad request.
    let url;
    try { url = new URL(request.url, "http://127.0.0.1"); }
    catch { response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad request"); return; }
    if (!this.hostAllowed(request.headers.host)) { response.writeHead(403).end(); return; }
    const pathname = url.pathname;
    // Management, pairing and setup stay local to this machine even when the
    // bridge is published for a remote browser: a published port must never hand
    // out the management surface.
    if (!BrowserBridge.loopback(request)) { response.writeHead(404).end(); return; }
    // Everything except the extension handshake needs the per-start secret that
    // only DSH can hand out; loopback alone is not an identity.
    if (!this.authorized(request, url)) {
      if (pathname === "/manage" || pathname === "/setup" || pathname === "/extension.zip") {
        response.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(deniedPage());
        return;
      }
      response.writeHead(404).end(); return;
    }
    if (pathname === "/manage/api" && request.method === "POST") return this.handleManagement(request, response);
    if (request.method === "POST" && pathname === "/setup/pair") return this.handlePairPost(request, response);
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (pathname === "/manage") {
      const { html, nonce } = managementPage();
      // The key never appears in the page body any more: the page authenticates
      // with this HttpOnly cookie, so a local process cannot read the key back by
      // fetching the management page.
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Set-Cookie": `dsh_manage=${this.manageSecret}; HttpOnly; SameSite=Strict; Path=/`,
        "Content-Security-Policy": `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
      response.end(html); return;
    }
    if (pathname === "/extension.zip") {
      // Hand the generated, already-paired extension to the user's browser. Local
      // only: the file carries the pairing token.
      const key = new URL(request.url, "http://127.0.0.1").searchParams.get("p") ?? "";
      const build = (this.extensionBuilds || []).find(entry => entry.key === key);
      if (!build) { response.writeHead(404).end(); return; }
      try {
        const bytes = await readFile(build.zip);
        response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": bytes.length, "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="dsh-doyourweb-${key}.zip"` });
        response.end(bytes);
      } catch { response.writeHead(404).end(); }
      return;
    }
    if (pathname !== "/setup") { response.writeHead(404).end(); return; }
    // The CSP nonce is minted per response: the only script the page may run is the
    // one behind the copy buttons, because a browser refuses web-page navigation to
    // `chrome://`/`edge://`, so opening the extension manager stays a user action.
    const nonce = randomBytes(16).toString("base64");
    // The form posts back with this cookie, so the PIN endpoint needs no key field.
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Set-Cookie": `dsh_manage=${this.manageSecret}; HttpOnly; SameSite=Strict; Path=/`,
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
    response.end(this.setupPage(nonce));
  }

  handleManagement(request, response) {
    const origin = `http://127.0.0.1:${this.port}`;
    const cookie = /(?:^|;\s*)dsh_manage=([0-9a-f]{32,})/.exec(request.headers.cookie || "")?.[1];
    if (!sameSecret(request.headers["x-dsh-key"] ?? cookie, this.manageSecret)
      || (request.headers.origin && request.headers.origin !== origin)
      || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")
      || request.headers["content-type"]?.split(";")[0] !== "application/json") { response.writeHead(403).end(); return; }
    let body = "", oversized = false;
    request.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 65536) { oversized = true; response.writeHead(413).end(); request.destroy(); } });
    request.on("end", async () => {
      if (oversized) return;
      try {
        if (!this.management) throw new Error("Management service is not ready");
        const result = await this.management(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
      } catch (error) {
        if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: error.message }));
      }
    });
  }

  setupPage(nonce) {
    const pending = this.pairings.list();
    // The PIN is never rendered here; the user copies it from the extension badge.
    const requests = pending.length ? `<form class="requests" method="post" action="/setup/pair">
      <label for="pin">扩展图标上的 4 位验证码</label>
      <input id="pin" name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4}" maxlength="4" required
        style="width:104px;font:600 18px/1.4 ui-monospace,monospace;letter-spacing:3px;padding:6px 8px;text-align:center;border:1px solid #ccd9d0;border-radius:8px">
      <button name="action" value="allow">&#20801;&#35768;</button></form>
      <p class="hint">有 ${pending.length} 条待确认请求。只输入你自己浏览器图标上显示的数字。</p>` : "";
    const copy = (label, value) => `<button type="button" class="copy" data-copy="${escapeHtml(value)}">${label}</button>`;
    const connected = this.profiles.size > 0;
    // The generated copies are the primary path: endpoint and token are already
    // inside, so loading the folder is the whole setup. The template folder plus a
    // pairing PIN remains as the fallback for a hand-copied installation.
    const builds = this.extensionBuilds || [];
    const downloads = builds.map(build => `<a href="/extension.zip?p=${encodeURIComponent(build.key)}" download>&#19979;&#36733; ${escapeHtml(build.label)}</a>`).join("");
    const install = `<div class="step"><span class="number">1</span><div><h2>&#23433;&#35013;&#27983;&#35272;&#22120;&#25193;&#23637;</h2>
      ${builds.length ? `<p>&#19979;&#36733;&#19982;&#26412;&#26426;&#37197;&#32622;&#21305;&#37197;&#30340;&#25193;&#23637;&#65292;&#35299;&#21387;&#21518;&#29992;&#12300;&#21152;&#36733;&#35299;&#21387;&#30340;&#25193;&#23637;&#12301;&#36873;&#20013;&#35813;&#30446;&#24405;&#21363;&#21487;&#65292;&#22320;&#22336;&#21644;&#37197;&#23545;&#20196;&#29260;&#24050;&#20869;&#32622;&#12290;</p><div class="actions">${downloads}</div><div class="path"><code>${escapeHtml(builds[0].dir)}</code>${copy("&#22797;&#21046;&#25193;&#23637;&#30446;&#24405;&#36335;&#24452;", builds[0].dir)}</div>`
        : `<p class="hint">&#25193;&#23637;&#23578;&#26410;&#29983;&#25104;&#65306;${escapeHtml(this.extensionBuildError || "&#37325;&#21551;&#25554;&#20214;&#21518;&#20250;&#29983;&#25104;")}</p>`}
      <details><summary>&#25163;&#21160;&#26041;&#24335;&#65288;&#27169;&#26495;&#30446;&#24405; + &#37197;&#23545;&#30721;&#65289;</summary><p>&#20063;&#21487;&#20197;&#30452;&#25509;&#21152;&#36733;&#20179;&#24211;&#37324;&#30340;&#27169;&#26495;&#30446;&#24405;&#65292;&#20877;&#25353;&#31532; 2 &#27493;&#36755;&#20837;&#25193;&#23637;&#22270;&#26631;&#19978;&#30340; 4 &#20301;&#39564;&#35777;&#30721;&#12290;</p><div class="path"><code>${escapeHtml(this.extensionPath)}</code>${copy("&#22797;&#21046;&#27169;&#26495;&#30446;&#24405;&#36335;&#24452;", this.extensionPath)}</div></details>
      <p class="hint">&#19979;&#36733;&#21518;&#22312; <code>edge://extensions</code> / <code>chrome://extensions</code> &#25171;&#24320;&#24320;&#21457;&#32773;&#27169;&#24335;&#65307;zip &#38656;&#35201;&#20808;&#35299;&#21387;&#12290;&#30446;&#24405;&#37324;&#24102;&#30528;&#37197;&#23545;&#20196;&#29260;&#65292;&#31561;&#21516;&#20110;&#23494;&#30721;&#65292;&#19981;&#35201;&#22806;&#20256;&#12290;</p></div></div>`;
    const body = `<main><header><div class="mark">↗</div><div><p class="eyebrow">DSH / BROWSER</p><h1>连接你的浏览器</h1></div><span class="badge ${connected ? "online" : ""}">${connected ? "已连接" : pending.length ? "待确认" : "等待连接"}</span></header>
      <p class="intro">让聊天接着你的网页工作。保留登录状态，在对话中用 @ 选择页面。</p>
      ${connected ? `<section class="success"><h2>连接已就绪</h2><p>回到 DSH，在输入框键入 <kbd>@</kbd>，选择需要使用的标签页。</p><p class="hint">已连接 ${this.profiles.size} 个浏览器配置。需要标注页面时，打开扩展并点击「批注当前页面」。</p></section><details><summary>连接另一个浏览器</summary>${install}</details>` : `<section class="card">${pending.length ? `<details><summary>扩展已发来请求 · 查看安装步骤</summary>${install}</details>` : install}</section>`}
      ${!connected || requests ? `<section class="card step"><span class="number">2</span><div><h2>输入验证码，确认连接</h2><p>扩展图标上的 4 位数字就是配对码，输入后点击允许。</p>${requests || `<div class="waiting"><span class="dot"></span>等待扩展发来请求…</div><p class="hint">加载扩展后配对请求会自动出现。</p>`}</div></section>` : ""}
      <details class="help"><summary>连接帮助、本地 HTML 与远程浏览器</summary><p>浏览器限制网页直接打开扩展管理页，请复制地址后粘贴到地址栏。</p><p>如果扩展显示 OFF，请打开扩展弹窗，检查连接开关，并在「连接设置」将端口设为 <code>${this.port}</code>。</p><p>本地 HTML：在扩展详情中开启「允许访问文件网址」，再用 @ 选择已打开的文件标签页。</p><p>远程浏览器：在「应用管理」页复制配对令牌，填到另一台电脑扩展的「连接设置」里（协议 ws 或 wss、主机、端口一致）。远程浏览器只能使用令牌连接，不能在本页配对。</p><p>扩展只连接 DSH 指定的地址，不读取 Cookie；只有在对话中引用的页面才允许操作。</p></details>
      <footer><span>DSH DoYourWeb · 本机连接</span><a href="/setup">刷新状态</a></footer></main>`;
    const script = `
      for (const button of document.querySelectorAll(".copy")) button.addEventListener("click", async () => {
        const value = button.dataset.copy;
        try { await navigator.clipboard.writeText(value); } catch {
          const field = document.createElement("textarea");
          field.value = value;
          document.body.append(field);
          field.select();
          document.execCommand("copy");
          field.remove();
        }
        const label = button.textContent;
        button.textContent = "\\u5df2\\u590d\\u5236";
        setTimeout(() => { button.textContent = label; }, 1500);
      });`;
    // Poll only while nothing is pending: a reload would fight the approve buttons.
    const refresh = pending.length || connected ? "" : `<meta http-equiv="refresh" content="3">`;
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>DSH DoYourWeb</title><style>
      *{box-sizing:border-box}body{margin:0;padding:48px 20px;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#253b38;background:#f2f5f3}main{max-width:780px;margin:auto}header{display:flex;align-items:center;gap:16px}.mark{width:48px;height:48px;display:grid;place-items:center;border-radius:14px;background:#1a6955;color:white;font-size:29px}.eyebrow{font-size:11px;letter-spacing:2px;color:#607d74;margin:0}h1{font-size:27px;letter-spacing:-.7px;margin:0}h2{font-size:17px;margin:0 0 6px}p{margin:6px 0 12px}.intro{margin:22px 0 28px;color:#596e68}.badge{margin-left:auto;white-space:nowrap;border:1px solid #d4ded9;padding:4px 11px;border-radius:20px;font-size:12px;color:#687a73}.online{background:#e0efe6;color:#176345;border-color:#c2ddcf}.card,.success{padding:24px;margin:16px 0;background:white;border:1px solid #dce5df;border-radius:16px;box-shadow:0 3px 12px #183c2605}.success{background:#e8f3ed;border-color:#bdd8c9}.step{display:flex;gap:16px}.step>div{min-width:0;flex:1}.number{flex-shrink:0;width:27px;height:27px;background:#eaf1ed;color:#36715c;border-radius:8px;text-align:center;font-weight:600}.actions{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0}.path{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f5f7f5;border:1px solid #e5eae6;border-radius:9px}.path code{flex:1;min-width:0;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}button{border:1px solid #d3ded6;background:white;color:#295b49;padding:8px 12px;border-radius:8px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}button:hover{background:#edf4ef;border-color:#9fbcaa}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #78b6a0;outline-offset:3px}.hint{color:#697b73;font-size:12px;margin-top:10px}ul{padding:0;list-style:none}.requests li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 16px;background:#f5f8f5;border-radius:10px;margin:10px 0}.requests strong{font:600 20px ui-monospace,monospace;letter-spacing:2px}form{display:flex;gap:8px}button[value=allow]{background:#1b7156;color:white;border-color:#1b7156}button[value=deny]{color:#6a756d}.waiting{display:flex;align-items:center;gap:8px;padding:12px;background:#f6f8f6;border-radius:8px;color:#697b73}.dot{width:7px;height:7px;background:#9caf9d;border-radius:50%}details{color:#5e756a}details .step{margin-top:18px}summary{cursor:pointer}.help{padding:14px 4px}.help p{font-size:13px;margin:12px 0}footer{display:flex;justify-content:space-between;border-top:1px solid #dbe3dd;margin-top:22px;padding-top:16px;font-size:12px;color:#7c8c82}a{color:#356f57}kbd{border:1px solid #b8d0c3;border-radius:5px;padding:1px 6px;background:white}@media(max-width:520px){body{padding:24px 14px}h1{font-size:22px}.mark{display:none}.card,.success{padding:18px}.path{flex-direction:column;align-items:stretch}.step{gap:10px}.badge{font-size:11px}footer{gap:12px}}
      </style><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
  }

  handlePairPost(request, response) {
    // Loopback only (enforced in handleHttp) and same-origin only: a page on
    // another origin cannot post here. The PIN is the human factor, and it is
    // compared against the badge code the extension was given — never against
    // anything this page renders.
    if (!BrowserBridge.loopback(request)) { response.writeHead(403).end(); return; }
    const sameOrigin = !request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin";
    if (!sameOrigin) { response.writeHead(403).end(); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
    request.on("end", () => {
      const fields = new URLSearchParams(body);
      if (fields.get("action") === "deny") {
        // Denial grants nothing, so an id is enough; it lets a user drop a request
        // they did not start without waiting for the two-minute expiry.
        this.pairings.take(fields.get("id") ?? "")?.socket.close(1000, "Pairing denied");
        response.writeHead(303, { Location: "/setup", "Cache-Control": "no-store" }).end();
        return;
      }
      const entry = this.pairings.match(fields.get("pin"));
      if (!entry) {
        this.pairingFailures += 1;
        // A wrong PIN is the signature of a local brute force; drop every pending
        // request and make each browser ask again.
        if (this.pairingFailures >= 5) { this.pairingFailures = 0; this.pairings.clear("Too many pairing attempts"); }
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
          .end("配对码不正确。请核对扩展图标上的 4 位数字后重试。");
        return;
      }
      this.pairingFailures = 0;
      this.approvePairing(entry.id);
      response.writeHead(303, { Location: "/setup", "Cache-Control": "no-store" }).end();
    });
  }

  acceptExtension(ws) {
    let profile;
    ws.on("error", () => {});
    ws.on("message", raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.method === "dsh.inventory") {
          const info = data.params;
          if (!/^[a-z0-9-]{1,80}$/i.test(info.profile) || !Array.isArray(info.tabs)
            || (info.browserSession !== undefined && !/^[a-z0-9-]{1,80}$/i.test(info.browserSession))) {
            throw new Error("Invalid inventory");
          }
          if (profile && (info.profile !== profile.sourceId || info.browserSession !== profile.sessionId)) {
            throw new Error("Profile identity changed");
          }
          if (!profile) {
            // A persisted profile does not identify a browser lifetime: Chrome can
            // reuse tab IDs after restart. Legacy clients get a connection-only ID.
            const id = info.browserSession ?? randomUUID();
            if (this.profiles.has(id) && this.profiles.get(id).sourceId !== info.profile) {
              throw new Error("Browser session identity collision");
            }
            for (const old of this.profiles.values()) {
              if (old.sourceId === info.profile) {
                this.profiles.delete(old.id);
                old.ws.close(1000, "Reconnected");
              }
            }
            profile = { id, sourceId: info.profile, sessionId: info.browserSession,
              ws, tabs: new Map(), browser: info.browser === "Edge" ? "Edge" : "Chrome" };
            this.profiles.set(profile.id, profile);
          }
          profile.tabs = new Map(info.tabs.filter(tab => Number.isSafeInteger(tab.id) && !tab.incognito && canControl(tab.url))
            .map(tab => [tab.id, { ...tab, ref: tabRef(profile.id, tab.id), browser: profile.browser,
              favicon: typeof tab.favicon === "string" && tab.favicon.length <= 12000
                && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(tab.favicon) ? tab.favicon : undefined,
            }]));
          for (const relay of [...this.relays.values()]) {
            if (relay.profile === profile && !profile.tabs.has(relay.tabId)) void this.dropRelay(relay);
          }
        } else if (profile && data.method === "dsh.annotation.start") {
          const selected = profile.tabs.get(data.params?.tabId);
          if (selected) this.emit("annotation", selected.ref);
        } else if (data.id && this.pending.has(data.id)) {
          const pending = this.pending.get(data.id);
          if (pending.ws !== ws) throw new Error("Wrong connection for response");
          this.pending.delete(data.id); clearTimeout(pending.timer);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
        } else if (profile && data.method === "chrome.debugger.onEvent") {
          const [source, method, params] = data.params;
          this.emit("debuggerEvent", profile, source, method, params);
          for (const relay of this.relays.values()) {
            if (relay.profile === profile && relay.tabId === source.tabId) relay.model.onDebuggerEvent(source, method, params);
          }
        } else if (profile && data.method === "chrome.debugger.onDetach") {
          for (const relay of [...this.relays.values()]) {
            if (relay.profile === profile && relay.tabId === data.params[0].tabId) this.dropRelay(relay);
          }
        } else if (data.method === "dsh.ping") ws.send(JSON.stringify({ method: "dsh.pong" }));
      } catch { ws.close(1003, "Invalid bridge message"); }
    });
    ws.on("close", () => {
      if (profile && this.profiles.get(profile.id) === profile) this.profiles.delete(profile.id);
      for (const [id, pending] of this.pending) {
        if (pending.ws === ws) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error("Browser extension disconnected")); }
      }
      for (const relay of [...this.relays.values()]) if (relay.profile === profile) this.dropRelay(relay);
    });
  }

  request(profile, method, params) {
    if (profile.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser extension disconnected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer, ws: profile.ws });
      profile.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  list(query = "") {
    const needle = query.toLowerCase().trim();
    return [...this.profiles.values()].flatMap(profile => [...profile.tabs.values()])
      .filter(tab => !needle || `${tab.title} ${tab.url} ${tab.browser}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 50);
  }

  resolve(ref) {
    const { profile: id, tabId } = parseRef(ref);
    const profile = this.profiles.get(id);
    if (!profile) throw new Error("Browser extension is offline or its browser session ended. Open /browser to connect, then select the tab with @ again.");
    const tab = profile.tabs.get(tabId);
    if (!tab) throw new Error("Referenced browser tab is closed or unsupported. Select a tab with @ again.");
    return { profile, tab, tabId };
  }

  async page(ref) {
    await this.detachments.get(ref);
    const { profile, tab, tabId } = this.resolve(ref);
    const existing = [...this.relays.values()].find(relay => relay.profile === profile && relay.tabId === tabId);
    if (existing) { clearTimeout(existing.idleTimer); return existing.ready; }
    const pathname = `/cdp/${randomUUID()}`;
    const model = new BrowserModel((method, params) => this.request(profile, method, params));
    model.onTabCreated(tab);
    const relay = { pathname, ref, profile, tabId, model };
    this.relays.set(pathname, relay);
    relay.ready = chromium.connectOverCDP(`ws://127.0.0.1:${this.port}${pathname}`, {
      headers: { Authorization: `Bearer ${this.settings.token}` }, timeout: 15000,
    }).then(async browser => {
      relay.browser = browser;
      browser.on("disconnected", () => this.dropRelay(relay));
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("Browser did not expose the referenced tab");
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(12000);
      await this.decoratePage?.(ref, page);
      return page;
    }).catch(error => { this.dropRelay(relay); throw error; });
    return relay.ready;
  }

  cdp(ref) {
    const { profile, tabId } = this.resolve(ref);
    const session = new EventEmitter();
    const receive = (owner, source, method, params) => {
      if (owner === profile && source.tabId === tabId && !source.sessionId) session.emit(method, params);
    };
    this.on("debuggerEvent", receive);
    session.send = (method, params) => this.request(profile, "chrome.debugger.sendCommand", [{ tabId }, method, params]);
    session.detach = async () => { this.off("debuggerEvent", receive); };
    return session;
  }

  acceptCDP(relay, ws) {
    relay.ws = ws;
    ws.on("error", () => {});
    const send = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    relay.model.connectOverCDP(send);
    ws.on("message", async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return this.dropRelay(relay); }
      // A CDP command without a numeric id can never be answered; dropping the
      // relay surfaces one protocol violation instead of hanging the caller.
      if (!Number.isSafeInteger(message?.id)) return this.dropRelay(relay);
      try {
        const result = await relay.model.command(message.method, message.params, message.sessionId);
        send({ id: message.id, sessionId: message.sessionId, result });
      } catch (error) { send({ id: message.id, sessionId: message.sessionId, error: { message: error.message } }); }
    });
    ws.on("close", () => this.dropRelay(relay));
  }

  dropRelay(relay) {
    if (!this.relays.delete(relay.pathname)) return this.detachments.get(relay.ref);
    clearTimeout(relay.idleTimer);
    this.emit("release", relay.ref);
    const cleanup = (async () => {
      try { await this.beforeRelease?.(relay.ref); } catch { /* Detach must finish even if a page has already gone away. */ }
      relay.ws?.close();
      const closing = relay.browser?.close().catch(() => {});
      const detached = relay.profile.ws.readyState === WebSocket.OPEN
        ? this.request(relay.profile, "chrome.debugger.detach", [{ tabId: relay.tabId }]).catch(() => {}) : undefined;
      await Promise.all([closing, detached]);
    })().finally(() => {
      if (this.detachments.get(relay.ref) === cleanup) this.detachments.delete(relay.ref);
    });
    this.detachments.set(relay.ref, cleanup);
    return cleanup;
  }

  release(ref) {
    const relay = [...this.relays.values()].find(relay => relay.ref === ref);
    if (!relay) return;
    clearTimeout(relay.idleTimer);
    relay.idleTimer = setTimeout(() => void this.dropRelay(relay), this.idleTimeoutMs);
    relay.idleTimer.unref();
  }

  async focus(ref) {
    const { profile, tabId } = this.resolve(ref);
    await this.request(profile, "dsh.focus", [tabId]);
  }

  async close() {
    for (const relay of [...this.relays.values()]) this.dropRelay(relay);
    await Promise.all(this.detachments.values());
    for (const client of this.ws?.clients || []) client.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Bridge stopped")); }
    this.pending.clear();
    this.ws?.close();
    if (this.server?.listening) await new Promise(resolve => {
      this.server.close(resolve);
      // Management-page fetch connections must not keep plugin unload waiting.
      this.server.closeAllConnections();
    });
  }
}
