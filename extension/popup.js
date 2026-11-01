import { config } from "./config.js";

const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
const pairing = document.querySelector("#pairing");
const code = document.querySelector("#code");
const scheme = document.querySelector("#scheme");
const host = document.querySelector("#host");
const port = document.querySelector("#port");
const tokenInput = document.querySelector("#token");
const endpointLabel = document.querySelector("#endpoint");
const savePort = document.querySelector("#save-port");
const saveToken = document.querySelector("#save-token");
const unpair = document.querySelector("#unpair");
document.querySelector("#setup").addEventListener("click", async () => {
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    const selectedPort = state.port ?? 43187;
    if (!Number.isSafeInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) throw new Error("连接端口无效");
    // The setup page exists only on the DSH machine; a remote browser pastes the
    // token it prints there instead of pairing on its own.
    if (!state.local) throw new Error("远程模式请在本机 DSH 的「应用管理 → 远程浏览器」复制配对令牌，粘贴到下面的输入框");
    await chrome.tabs.create({ url: `http://127.0.0.1:${selectedPort}/setup` });
  } catch (error) { showError(error); }
});
// The CA travels inside this package. Downloading it is all an extension may do:
// adding a root to the trust store is an OS action with no extension API (the only
// certificate API, certificateProvider, is ChromeOS-only), and Windows asks for its
// own confirmation anyway.
if (config.ca) {
  const panel = document.querySelector("#ca");
  panel.hidden = false;
  panel.open = false;
  document.querySelector("#install-ca").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = chrome.runtime.getURL(config.ca);
    link.download = "dsh-doyourweb-remote-ca.crt";
    document.body.append(link);
    link.click();
    link.remove();
  });
}
// A browser hides certificate errors from extension JavaScript, so the only honest
// diagnostic is to let the user see the page itself: a warning means the CA is not
// trusted yet, the gate explanation means TLS is fine and the problem is elsewhere.
document.querySelector("#check-link").addEventListener("click", async () => {
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    const scheme = state.scheme === "wss" ? "https" : "http";
    const host = state.host ?? "127.0.0.1";
    const selectedPort = Number.isSafeInteger(state.port) ? state.port : 43187;
    await chrome.tabs.create({ url: `${scheme}://${host}:${selectedPort}/setup` });
  } catch (error) { showError(error); }
});
document.querySelector("#file-access").textContent = await chrome.extension.isAllowedFileSchemeAccess()
  ? "已允许引用本地 HTML 页面" : "引用本地 HTML：请在浏览器扩展详情中开启“允许访问文件网址”。";

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "status" });
  if (state.error) throw new Error(state.error);
  const waiting = state.pairing !== undefined && !state.stopped;
  enabled.checked = !state.stopped;
  if (document.activeElement !== port) port.value = String(state.port ?? 43187);
  if (document.activeElement !== host) host.value = state.host ?? "127.0.0.1";
  if (document.activeElement !== scheme) scheme.value = state.scheme ?? "ws";
  endpointLabel.textContent = state.endpoint ? `当前地址：${state.endpoint}${state.local ? "" : "（远程）"}` : "";
  unpair.hidden = !state.paired;
  pairing.hidden = !waiting;
  document.querySelector("#setup").hidden = state.connected || !state.local;
  code.textContent = state.pairing?.code ?? "";
  status.textContent = waiting ? "\u5c06\u4e0b\u9762\u7684\u9a8c\u8bc1\u7801\u8f93\u5165 DSH \u8fde\u63a5\u9875\u9762"
    : state.connected ? `\u5df2\u8fde\u63a5 \u00b7 ${state.availableTabs} \u4e2a\u6807\u7b7e\u9875 \u00b7 ${state.controlledTabs} \u4e2a\u53d7\u63a7`
      : state.stopped ? "\u5df2\u6682\u505c" : state.paired ? "\u7b49\u5f85 DSH" : state.local ? "\u672a\u914d\u5bf9" : "\u7b49\u5f85\u914d\u5bf9\u4ee4\u724c";
}

function showError(error) { status.textContent = error.message; }
for (const type of ["annotate", "manage"]) document.querySelector(`#${type}`).addEventListener("click", () => {
  void send({ type }).catch(showError);
});

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw new Error(result.error);
  await refresh();
}

enabled.addEventListener("change", async () => {
  enabled.disabled = true;
  try { await send({ type: "toggle", stopped: !enabled.checked }); }
  catch (error) { showError(error); }
  finally { enabled.disabled = false; }
});
savePort.addEventListener("click", async () => {
  try { await send({ type: "host", scheme: scheme.value, host: host.value.trim(), port: Number(port.value) }); }
  catch (error) { showError(error); }
});
saveToken.addEventListener("click", async () => {
  try {
    await send({ type: "token", token: tokenInput.value });
    tokenInput.value = "";
  } catch (error) { showError(error); }
});
unpair.addEventListener("click", async () => {
  // Remote browsers cannot pair on their own: clearing the token strands the user
  // until they reinstall the package or copy the token out of the management page.
  if (!confirm("解除配对会清空这台浏览器里的配对令牌，远程连接将立即断开，且需要重新安装扩展或从 DSH「应用管理 → 远程浏览器」复制令牌才能恢复。确定要解除吗？")) return;
  try { await send({ type: "unpair" }); }
  catch (error) { showError(error); }
});

await refresh().catch(showError);
const timer = setInterval(() => void refresh().catch(showError), 2000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
