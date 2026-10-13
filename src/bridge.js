import http from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright-core";
import { BrowserModel } from "./vendor/browser-model.js";
import { extensionId, Pairings, pinnedExtensionId } from "./pairing.js";
import { canControl, parseRef, tabRef } from "./protocol.js";

export { extensionId } from "./pairing.js";

export function sameSecret(actual, expected) {
  const a = Buffer.from(actual || ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class BrowserBridge {
  constructor({ home, port = 43187, extensionSource } = {}) {
    this.home = home;
    this.port = port;
    this.extensionSource = extensionSource || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension");
    this.profiles = new Map();
    this.relays = new Map();
    this.pending = new Map();
    this.pairings = new Pairings();
    this.setupKey = randomBytes(16).toString("hex");
    this.sequence = 0;
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
    this.extensionPath = this.extensionSource;
    this.manifest = JSON.parse(await readFile(path.join(this.extensionSource, "manifest.json"), "utf8"));
    this.id = pinnedExtensionId(this.manifest);
    // Installations created before 0.1.3 loaded a generated copy pinned to a
    // per-install key; keep accepting that origin so they keep working.
    this.legacyId = typeof this.settings.key === "string" && this.settings.key.length ? extensionId(this.settings.key) : undefined;
  }

  /** Whether a WebSocket origin may talk to this bridge at all. */
  trustedOrigin(origin) {
    return origin === `chrome-extension://${this.id}` || (this.legacyId !== undefined && origin === `chrome-extension://${this.legacyId}`);
  }

  async start() {
    await this.prepareExtension();
    this.server = http.createServer((request, response) => this.handleHttp(request, response));
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.server.on("upgrade", (request, socket, head) => {
      if (request.headers.host !== `127.0.0.1:${this.port}`) return socket.destroy();
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname === "/extension") {
        const protocols = (request.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim());
        if (!this.trustedOrigin(request.headers.origin)) return socket.destroy();
        // A token means an already paired browser; its absence asks for pairing.
        if (sameSecret(protocols[1], this.settings.token)) this.ws.handleUpgrade(request, socket, head, ws => this.acceptExtension(ws));
        else if (protocols[1] === undefined && request.headers.origin === `chrome-extension://${this.id}`) {
          this.ws.handleUpgrade(request, socket, head, ws => this.acceptPairing(ws));
        } else socket.destroy();
      } else {
        const relay = this.relays.get(pathname);
        if (!relay || request.headers.origin || !sameSecret(request.headers.authorization, `Bearer ${this.settings.token}`) || relay.ws) return socket.destroy();
        this.ws.handleUpgrade(request, socket, head, ws => this.acceptCDP(relay, ws));
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    }).catch(error => {
      if (error.code !== "EADDRINUSE") throw error;
      throw new Error(`Browser bridge port ${this.port} is already in use. Another DSH instance, another application, or a bridge leaked by an older plugin version owns it; stop that instance or set a different "port" in the plugin settings.`);
    });
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/setup`;
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
    ws.on("close", () => this.pairings.drop(ws));
    ws.send(JSON.stringify({ method: "dsh.pairing", params: {
      id: pairing.id, code: pairing.code, expiresAt: pairing.expires, port: this.port,
    } }));
  }

  handleHttp(request, response) {
    if (request.headers.host !== `127.0.0.1:${this.port}`) { response.writeHead(403).end(); return; }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "POST" && pathname === "/setup/pair") return this.handlePairPost(request, response);
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (pathname !== "/setup") { response.writeHead(404).end(); return; }
    // The CSP nonce is minted per response: the only script the page may run is the
    // one behind the copy buttons, because a browser refuses web-page navigation to
    // `chrome://`/`edge://`, so opening the extension manager stays a user action.
    const nonce = randomBytes(16).toString("base64");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
    response.end(this.setupPage(nonce));
  }

  setupPage(nonce) {
    const pending = this.pairings.list();
    const requests = pending.map(entry => `<li><strong>&#39564;&#35777;&#30721; ${escapeHtml(entry.code)}</strong>
      <form method="post" action="/setup/pair"><input type="hidden" name="key" value="${escapeHtml(this.setupKey)}">
      <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
      <button name="action" value="allow">&#20801;&#35768;</button>
      <button name="action" value="deny">&#25298;&#32477;</button></form></li>`).join("");
    const copy = (label, value) => `<button type="button" class="copy" data-copy="${escapeHtml(value)}">${label}</button>`;
    const body = `
      <h1>DSH Browser Tabs</h1>
      <p class="status">${this.profiles.size ? "&#24050;&#36830;&#25509;&#27983;&#35272;&#22120;" : "&#31561;&#24453;&#27983;&#35272;&#22120;&#25193;&#23637;&#36830;&#25509;"}</p>
      <ol>
        <li>&#22312; Edge &#25110; Chrome &#30340;&#25193;&#23637;&#31649;&#29702;&#39029;&#25171;&#24320;&#24320;&#21457;&#32773;&#27169;&#24335;&#65292;&#36873;&#25321;&#8220;&#21152;&#36733;&#35299;&#21387;&#30340;&#25193;&#23637;&#8221;&#65306;${copy("\u590d\u5236\u6269\u5c55\u76ee\u5f55\u8def\u5f84", this.extensionPath)}&#65288;&#31896;&#21040;&#25991;&#20214;&#36873;&#25321;&#26694;&#65292;macOS &#25353; &#8679;&#8984;G&#65289;</li>
        <li>&#25193;&#23637;&#25171;&#24320;&#21518;&#20250;&#33258;&#21160;&#35831;&#27714;&#37197;&#23545;&#65292;&#24037;&#20855;&#26639;&#24494;&#26631;&#26174;&#31034; 4 &#20301;&#39564;&#35777;&#30721;&#12290;</li>
        <li>&#22312;&#19979;&#26041;&#28857;&#20987;&#39564;&#35777;&#30721;&#30456;&#21516;&#30340;&#8220;&#20801;&#35768;&#8221;&#21363;&#21487;&#23436;&#25104;&#37197;&#23545;&#65292;&#26080;&#38656;&#36755;&#20837;&#20219;&#20309;&#20869;&#23481;&#12290;</li>
      </ol>
      ${requests ? `<h2>&#37197;&#23545;&#35831;&#27714;</h2><ul>${requests}</ul>` : `<p>&#26242;&#26080;&#37197;&#23545;&#35831;&#27714;&#12290;&#25171;&#24320;&#25193;&#23637;&#24377;&#31383;&#25110;&#37325;&#21551;&#27983;&#35272;&#22120;&#21518;&#25193;&#23637;&#20250;&#33258;&#21160;&#21457;&#36215;&#12290;</p>`}
      <p class="hint">&#27983;&#35272;&#22120;&#19981;&#20801;&#35768;&#32593;&#39029;&#25171;&#24320;&#25193;&#23637;&#31649;&#29702;&#39029;&#65292;&#35831;&#22797;&#21046;&#22320;&#22336;&#31896;&#21040;&#22320;&#22336;&#26639;&#65306;${copy("edge://extensions", "edge://extensions")}${copy("chrome://extensions", "chrome://extensions")}</p>
      <p class="hint">&#22914;&#26524;&#25193;&#23637;&#19968;&#30452;&#26174;&#31034; OFF&#65292;&#35831;&#22312;&#25193;&#23637;&#24377;&#31383;&#25226;&#31471;&#21475;&#35774;&#20026; <span class="code">${this.port}</span>&#12290;</p>
      <p class="hint">&#25193;&#23637;&#21482;&#36830;&#25509;&#26412;&#26426;&#65292;&#19981;&#35835;&#21462; Cookie&#12290;&#21482;&#25511;&#21046;&#22312;&#23545;&#35805;&#20013;&#24341;&#29992;&#30340; HTTP/HTTPS &#26631;&#31614;&#39029;&#12290;</p>
      <details><summary>&#23436;&#25972;&#36335;&#24452;</summary><code>${escapeHtml(this.extensionPath)}</code></details>
      <p><a href="/setup">&#21047;&#26032;</a></p>`;
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
    const refresh = pending.length ? "" : `<meta http-equiv="refresh" content="3">`;
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>DSH Browser Tabs</title><style>body{margin:40px auto;padding:0 20px;max-width:760px;font:15px/1.8 system-ui;color:#252525;background:#fff}h1{font-size:24px}code,.code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace}details code{display:inline-block;padding:8px;overflow-wrap:anywhere;margin-top:6px}li{margin:12px 0}.status{color:#237841}.hint{color:#6b7280;font-size:13px}a{color:#1766bf}form{display:inline}button{margin:2px 4px;padding:4px 12px;cursor:pointer}</style><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
  }

  handlePairPost(request, response) {
    // Same-origin form post plus the per-start key: a page on another origin can
    // neither read the key nor post here with this content type.
    const sameOrigin = !request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin";
    if (!sameOrigin) { response.writeHead(403).end(); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
    request.on("end", () => {
      const fields = new URLSearchParams(body);
      if (!sameSecret(fields.get("key"), this.setupKey)) { response.writeHead(403).end(); return; }
      const id = fields.get("id") ?? "";
      if (fields.get("action") === "allow") this.approvePairing(id);
      else this.pairings.take(id);
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
          if (!/^[a-z0-9-]{1,80}$/i.test(info.profile) || !Array.isArray(info.tabs)) throw new Error("Invalid inventory");
          if (profile && info.profile !== profile.id) throw new Error("Profile identity changed");
          if (!profile) {
            this.profiles.get(info.profile)?.ws.close(1000, "Reconnected");
            profile = { id: info.profile, ws, tabs: new Map(), browser: info.browser === "Edge" ? "Edge" : "Chrome" };
            this.profiles.set(profile.id, profile);
          }
          profile.tabs = new Map(info.tabs.filter(tab => Number.isSafeInteger(tab.id) && !tab.incognito && canControl(tab.url))
            .map(tab => [tab.id, { ...tab, ref: tabRef(profile.id, tab.id), browser: profile.browser,
              favicon: typeof tab.favicon === "string" && tab.favicon.length <= 12000
                && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(tab.favicon) ? tab.favicon : undefined,
            }]));
        } else if (data.id && this.pending.has(data.id)) {
          const pending = this.pending.get(data.id);
          if (pending.ws !== ws) throw new Error("Wrong connection for response");
          this.pending.delete(data.id); clearTimeout(pending.timer);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
        } else if (profile && data.method === "chrome.debugger.onEvent") {
          const [source, method, params] = data.params;
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
    if (!profile) throw new Error("Browser extension is offline. Open /browser in DSH to connect it.");
    const tab = profile.tabs.get(tabId);
    if (!tab) throw new Error("Referenced browser tab is closed or unsupported. Select a tab with @ again.");
    return { profile, tab, tabId };
  }

  async page(ref) {
    const { profile, tab, tabId } = this.resolve(ref);
    const existing = [...this.relays.values()].find(relay => relay.profile === profile && relay.tabId === tabId);
    if (existing) return existing.ready;
    const pathname = `/cdp/${randomUUID()}`;
    const model = new BrowserModel((method, params) => this.request(profile, method, params));
    model.onTabCreated(tab);
    const relay = { pathname, profile, tabId, model };
    this.relays.set(pathname, relay);
    relay.ready = chromium.connectOverCDP(`ws://127.0.0.1:${this.port}${pathname}`, {
      headers: { Authorization: `Bearer ${this.settings.token}` }, timeout: 15000,
    }).then(browser => {
      relay.browser = browser;
      browser.on("disconnected", () => this.dropRelay(relay));
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("Browser did not expose the referenced tab");
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(12000);
      return page;
    }).catch(error => { this.dropRelay(relay); throw error; });
    return relay.ready;
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
    if (!this.relays.delete(relay.pathname)) return;
    relay.ws?.close();
    relay.browser?.close().catch(() => {});
    if (relay.profile.ws.readyState === WebSocket.OPEN) {
      void this.request(relay.profile, "chrome.debugger.detach", [{ tabId: relay.tabId }]).catch(() => {});
    }
  }

  async focus(ref) {
    const { profile, tabId } = this.resolve(ref);
    await this.request(profile, "dsh.focus", [tabId]);
  }

  async close() {
    for (const relay of [...this.relays.values()]) this.dropRelay(relay);
    for (const client of this.ws?.clients || []) client.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Bridge stopped")); }
    this.pending.clear();
    this.ws?.close();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
