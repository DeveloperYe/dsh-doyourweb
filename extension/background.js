import { config } from "./config.js";

let socket;
let profile;
let browserSession;
let timer;
let retryTimer;
let ready;
let cleanup = Promise.resolve();
let retry = 1000;
let stopped = false;
let inventoryTimer;
let availableTabs = 0;
let inventoryGeneration = 0;
// Pairing state: the token is stored in browser storage, never in a shipped file.
// It is either handed over by the local setup page after the user types the badge
// PIN, or pasted by the user for a remote DSH machine that cannot offer pairing.
let token = config.token || "";
let port = config.port || 43187;
let host = config.host || "127.0.0.1";
let scheme = config.scheme || "ws";
let pairing;
const favicons = new Map();
const attached = new Set();
const browser = navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";

function send(message, connection = socket) {
  if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
}
let fileAccess = false;
function supported(tab) { return !tab.incognito && (/^https?:\/\//.test(tab.url || "") || (fileAccess && /^file:\/\//.test(tab.url || ""))); }

function faviconKey(tab) { return `${tab.url}\n${tab.favIconUrl || ""}`; }

async function cachedFavicon(tab) {
  const key = faviconKey(tab);
  if (favicons.has(key)) return favicons.get(key).pending;
  const entry = {};
  entry.pending = (async () => {
    try {
      const url = new URL(chrome.runtime.getURL("_favicon/"));
      url.searchParams.set("pageUrl", tab.url);
      url.searchParams.set("size", "16");
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 8192) return;
      // Chromium's cached favicon endpoint can omit Content-Type.
      if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte)) return;
      entry.image = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
      return entry.image;
    } catch { /* Sites without a cached favicon use the DSH globe icon. */ }
  })();
  favicons.set(key, entry);
  return entry.pending;
}

async function inventory() {
  const connection = socket;
  if (!token || connection?.readyState !== WebSocket.OPEN) return;
  const generation = ++inventoryGeneration;
  fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  const tabs = (await chrome.tabs.query({})).filter(supported);
  if (socket !== connection || generation !== inventoryGeneration) return;
  availableTabs = tabs.length;
  const liveKeys = new Set(tabs.map(faviconKey));
  for (const key of favicons.keys()) if (!liveKeys.has(key)) favicons.delete(key);
  const rows = tabs.map(tab => ({
    id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId, active: tab.active,
    lastAccessed: tab.lastAccessed, incognito: false, favicon: favicons.get(faviconKey(tab))?.image,
  }));
  // Publish metadata immediately; local icon reads must not delay tab discovery.
  send({ method: "dsh.inventory", params: { profile, browserSession, browser, tabs: rows } }, connection);
  const images = await Promise.all(tabs.map(cachedFavicon));
  if (socket !== connection || generation !== inventoryGeneration) return;
  if (images.some((image, index) => image !== rows[index].favicon)) {
    send({ method: "dsh.inventory", params: { profile, browserSession, browser,
      tabs: rows.map((tab, index) => ({ ...tab, favicon: images[index] })) } }, connection);
  }
}

function scheduleInventory() {
  clearTimeout(inventoryTimer);
  inventoryTimer = setTimeout(() => void inventory().catch(console.warn), 150);
}

async function command(message, connection) {
  const args = message.params || [];
  const target = args[0];
  switch (message.method) {
    case "chrome.debugger.attach": {
      const tab = await chrome.tabs.get(target.tabId);
      fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!supported(tab)) throw new Error("Use a regular web or local file tab; enable Allow access to file URLs in extension details for local pages");
      if (!attached.has(target.tabId)) {
        await chrome.debugger.attach(target, "1.3");
        if (socket !== connection || stopped) {
          await chrome.debugger.detach(target).catch(() => {});
          throw new Error("Browser bridge disconnected during attachment");
        }
        attached.add(target.tabId);
        await chrome.action.setBadgeText({ tabId: target.tabId, text: "DSH" });
        await chrome.action.setBadgeBackgroundColor({ tabId: target.tabId, color: "#237841" });
      }
      return {};
    }
    case "chrome.debugger.detach":
      if (attached.delete(target.tabId)) {
        await chrome.debugger.detach(target).catch(() => {});
        await chrome.action.setBadgeText({ tabId: target.tabId, text: "" }).catch(() => {});
      }
      return {};
    case "chrome.debugger.sendCommand":
      if (!attached.has(target.tabId)) throw new Error("Tab is not attached");
      return chrome.debugger.sendCommand(target, args[1], args[2]);
    case "dsh.focus": {
      const tab = await chrome.tabs.get(target);
      if (!supported(tab)) throw new Error("Tab is unsupported");
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return {};
    }
    default: throw new Error("Unsupported browser bridge command");
  }
}

function disconnect() {
  const connection = socket;
  socket = undefined;
  pairing = undefined;
  clearInterval(timer);
  clearTimeout(retryTimer);
  clearTimeout(inventoryTimer);
  connection?.close();
  const tabIds = [...attached];
  attached.clear();
  cleanup = cleanup.then(() => Promise.all(tabIds.map(async tabId => {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  })));
  void updateStatus();
  return cleanup;
}

async function updateStatus() {
  const connected = !!token && socket?.readyState === WebSocket.OPEN && !pairing;
  const title = stopped ? "\u5df2\u6682\u505c"
    : pairing ? `\u914d\u5bf9\u4e2d \u00b7 ${pairing.code}`
      : !token ? (localHost() ? "\u672a\u914d\u5bf9" : "\u7b49\u5f85\u914d\u5bf9\u4ee4\u724c")
        : connected ? `\u5df2\u8fde\u63a5 \u00b7 ${host}` : `\u7b49\u5f85 DSH \u00b7 ${host}`;
  await chrome.action.setTitle({ title: `DSH DoYourWeb - ${title}` });
  // While unpaired the badge is the code the user compares with the DSH setup page.
  await chrome.action.setBadgeText({ text: pairing ? pairing.code : connected || stopped ? "" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: pairing ? "#b45309" : "#6b7280" });
}

/** 127.0.0.1 / browser.lan.example / [::1] -> a host section a URL can use. */
function endpoint() {
  const name = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${name}:${port}/extension`;
}

function localHost() {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

async function connect() {
  await ready;
  await cleanup;
  if (stopped || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  clearTimeout(retryTimer);
  // No token means "please pair me"; a remote bridge never offers pairing, so a
  // remote browser must hold a token the user copied from the DSH management page.
  const protocols = token ? ["dsh-browser", token] : ["dsh-browser"];
  const connection = new WebSocket(endpoint(), protocols);
  socket = connection;
  connection.onopen = () => {
    if (socket !== connection) return connection.close();
    retry = 1000;
    pairing = undefined;
    void updateStatus();
    if (token) void inventory().catch(console.warn);
    timer = setInterval(() => send({ method: "dsh.ping" }, connection), 20000);
  };
  connection.onmessage = async event => {
    if (socket !== connection) return;
    let message;
    try {
      message = JSON.parse(event.data);
      if (message.method === "dsh.pairing") {
        pairing = message.params;
        void updateStatus();
        return;
      }
      if (message.method === "dsh.paired") {
        token = message.params.token;
        port = message.params.port || port;
        pairing = undefined;
        retry = 1000;
        await chrome.storage.local.set({ token, port });
        void updateStatus();
        connection.close();
        return;
      }
      if (!Number.isSafeInteger(message.id)) return;
      const result = await command(message, connection);
      send({ id: message.id, result: result ?? {} }, connection);
    } catch (error) { if (message?.id) send({ id: message.id, error: error.message }, connection); }
  };
  connection.onerror = () => {};
  connection.onclose = async () => {
    if (socket !== connection) return;
    await disconnect();
    if (!stopped && !socket) {
      retryTimer = setTimeout(() => void connect().catch(console.warn), retry);
      retry = Math.min(30000, retry * 2);
    }
  };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (attached.has(source.tabId)) send({ method: "chrome.debugger.onEvent", params: [source, method, params] });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const controlled = attached.delete(source.tabId);
  void chrome.action.setBadgeText({ tabId: source.tabId, text: "" }).catch(() => {});
  if (controlled) send({ method: "chrome.debugger.onDetach", params: [source, reason] });
});
chrome.tabs.onUpdated.addListener(scheduleInventory);
chrome.tabs.onCreated.addListener(scheduleInventory);
chrome.tabs.onRemoved.addListener(scheduleInventory);
chrome.tabs.onActivated.addListener(scheduleInventory);
const reconnect = () => { void connect().catch(console.warn); };
chrome.runtime.onStartup.addListener(reconnect);
chrome.runtime.onInstalled.addListener(reconnect);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "reconnect") reconnect(); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (_sender.id !== chrome.runtime.id || (_sender.url && _sender.url !== chrome.runtime.getURL("popup.html"))) return;
  if (!["status", "toggle", "unpair", "port", "host", "token", "annotate", "manage"].includes(message.type)) return;
  void (async () => {
    await ready;
    if (message.type === "manage") {
      if (!localHost()) throw new Error("管理页只在 DSH 本机可用；远程连接请在本机 /manage 里复制令牌");
      await chrome.tabs.create({ url: `http://127.0.0.1:${port}/manage` }); respond({ ok: true }); return;
    }
    if (message.type === "annotate") {
      if (!token || socket?.readyState !== WebSocket.OPEN || pairing) throw new Error("请先连接 DSH");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!tab || !supported(tab)) throw new Error("请选择网页或本地 HTML；本地页面需在扩展详情中开启“允许访问文件网址”");
      send({ method: "dsh.annotation.start", params: { tabId: tab.id } }); respond({ ok: true }); return;
    }
    if (message.type === "status") {
      respond({ connected: !!token && socket?.readyState === WebSocket.OPEN && !pairing,
        availableTabs, controlledTabs: attached.size, stopped, paired: !!token,
        pairing: pairing === undefined ? undefined : { code: pairing.code, expiresAt: pairing.expiresAt },
        port, host, scheme, local: localHost(), endpoint: endpoint() });
      return;
    }
    if (message.type === "host") {
      // Where this browser looks for DSH: same machine, a LAN address, or a
      // tunnel hostname ending in wss. A remote bridge never offers pairing.
      const nextScheme = message.scheme === "wss" ? "wss" : "ws";
      const nextHost = String(message.host ?? "").trim();
      if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(nextHost)) throw new Error("主机名只允许字母、数字、点、横线，或方括号包裹的 IPv6 地址");
      const nextPort = Number(message.port ?? port);
      if (!Number.isSafeInteger(nextPort) || nextPort < 1 || nextPort > 65535) throw new Error("端口必须是 1-65535 之间的整数");
      scheme = nextScheme; host = nextHost; port = nextPort;
      await chrome.storage.local.set({ scheme, host, port });
      await disconnect();
      await connect();
      await updateStatus();
      respond({ ok: true, endpoint: endpoint() });
      return;
    }
    if (message.type === "token") {
      // Manual pairing for a remote bridge: paste the token shown on the DSH
      // management page. It is the only credential a remote browser can use.
      const value = String(message.token ?? "").trim().toLowerCase();
      if (value && !/^[0-9a-f]{64}$/.test(value)) throw new Error("配对令牌应为 64 位十六进制字符，请从 DSH 的「应用管理 → 远程浏览器」复制");
      token = value;
      pairing = undefined;
      if (value) await chrome.storage.local.set({ token }); else await chrome.storage.local.remove(["token"]);
      await disconnect();
      retry = 1000;
      await connect();
      await updateStatus();
      respond({ ok: true });
      return;
    }
    if (message.type === "unpair") {
      token = "";
      pairing = undefined;
      await chrome.storage.local.remove(["token"]);
      await disconnect();
      await connect();
      await updateStatus();
      respond({ ok: true });
      return;
    }
    if (message.type === "port") {
      const next = Number(message.port);
      if (!Number.isSafeInteger(next) || next < 1 || next > 65535) throw new Error("端口必须是 1-65535 之间的整数");
      port = next;
      await chrome.storage.local.set({ port });
      await disconnect();
      await connect();
      respond({ ok: true });
      return;
    }
    stopped = message.stopped === true;
    await chrome.storage.local.set({ stopped });
    if (stopped) await disconnect(); else await connect();
    await updateStatus();
    respond({ ok: true });
  })().catch(error => respond({ error: error.message }));
  return true;
});

// MV3 service workers register listeners synchronously and cannot use top-level await.
ready = (async () => {
  const stored = await chrome.storage.local.get(["profile", "stopped", "token", "port", "host", "scheme"]);
  profile = stored.profile || crypto.randomUUID();
  // Session storage survives worker suspension, but never a full browser restart.
  const session = await chrome.storage.session.get(["browserSession"]);
  browserSession = session.browserSession || crypto.randomUUID();
  await chrome.storage.session.set({ browserSession });
  stopped = stored.stopped === true;
  token = stored.token || config.token || "";
  port = stored.port || config.port || 43187;
  host = stored.host || config.host || "127.0.0.1";
  scheme = stored.scheme === "wss" ? "wss" : (stored.scheme || config.scheme || "ws");
  await chrome.storage.local.set({ profile });
  await chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  await updateStatus();
})();
reconnect();
