import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

/** Read a whole response as text, tolerating either transport. */
function get(url, { insecure = false } = {}) {
  const send = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const call = send(url, { rejectUnauthorized: !insecure }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    call.on("error", reject);
    call.end();
  });
}

async function tlsBridge(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-setup-page-"));
  const bridge = new BrowserBridge({
    home, port: 0, tls: true, tlsPort: 0, bind: "127.0.0.1",
    publicUrl: "https://browser.example.test", remote: true, hosts: ["browser.example.test"], autoBuild: false,
  });
  await bridge.start();
  t.after(async () => { await bridge.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return bridge;
}

test("the setup page renders over TLS instead of throwing", async t => {
  const bridge = await tlsBridge(t);
  // This is the page that used to call a certificateNotice() that did not exist: the throw
  // escaped the request handler, became an unhandled rejection, and exited the whole host.
  const response = await get(`https://127.0.0.1:${bridge.tlsPort}/setup?k=${bridge.manageSecret}`, { insecure: true });
  assert.equal(response.status, 200);
  assert.match(response.body, /连接你的浏览器/, "the page is rendered, not blank");
  assert.match(response.body, /下载 CA 证书/, "the trust-anchor notice appears when TLS is on");
  assert.ok(response.body.length > 2000, `a real page, not a stub (${response.body.length} bytes)`);
});

test("a rendering bug answers 500 and leaves the process running", async t => {
  const bridge = await tlsBridge(t);
  // Simulate any future page-rendering regression: it must not reach the event loop, and it
  // must not be disguised as an empty 200 either.
  bridge.connectionsSection = () => { throw new Error("boom from a page fragment"); };
  const response = await get(`https://127.0.0.1:${bridge.tlsPort}/setup?k=${bridge.manageSecret}`, { insecure: true });
  assert.equal(response.status, 500);
  assert.match(response.body, /页面渲染失败/);
  assert.match(response.body, /boom from a page fragment/);

  // The rest of the management surface still works afterwards.
  const manage = await get(`https://127.0.0.1:${bridge.tlsPort}/manage?k=${bridge.manageSecret}`, { insecure: true });
  assert.equal(manage.status, 200);
});

test("plain HTTP on the TLS port cannot be answered, but must not take the bridge down", async t => {
  const bridge = await tlsBridge(t);
  // The handshake fails before any HTTP parsing, so the browser shows ERR_EMPTY_RESPONSE; what
  // matters is that the failed handshake is contained and the listener keeps serving TLS.
  await new Promise(resolve => {
    const socket = net.connect(bridge.tlsPort, "127.0.0.1", () => {
      socket.write("GET /setup HTTP/1.1\r\nHost: browser.example.test\r\nConnection: close\r\n\r\n");
    });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    socket.setTimeout(5000, () => { socket.destroy(); resolve(); });
  });

  const after = await get(`https://127.0.0.1:${bridge.tlsPort}/manage?k=${bridge.manageSecret}`, { insecure: true });
  assert.equal(after.status, 200, "a bad handshake does not break the listener");
  assert.equal(bridge.tlsActive, true);
});
