import { Context } from "@deepseek-ai/cordis";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { apply } from "../../src/host.js";
import { BrowserEngine } from "../../src/engine.js";
import { BrowserBridge } from "../../src/bridge.js";
import { WebMCP } from "../../src/webmcp.js";

async function openPort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
async function closePort(server) { await new Promise(resolve => server.close(resolve)); }

const root = new Context();
const tools = new Map();
root.provide("tools", { register(definition) { tools.set(definition.name, definition); } });
let rejectRegistration = process.argv[3] === "failed-activation";
root.provide("typert", { register() {
  if (rejectRegistration) { rejectRegistration = false; throw new Error("Test registration failure"); }
} });
let failed = false;
try {
  const probe = await openPort();
  const port = probe.address().port;
  await closePort(probe);
  const plugin = { name: "browser-tabs-test", inject: ["tools", "typert"],
    apply: ctx => apply(ctx, { home: process.argv[2], port }) };
  if (process.argv[3] === "budget") {
    WebMCP.prototype.list = async () => ({ supported: false, tools: [] });
    const reads = [];
    BrowserEngine.prototype.read = async (ref, options) => {
      reads.push(options.limit);
      return { tab: ref, content: "<".repeat(Math.floor((options.limit - 100) / 6)) };
    };
    const fiber = root.plugin(plugin);
    await fiber.await();
    const agent = { session: { id: "budget-session" } };
    const user = { id: "budget-message", source: { kind: "user" }, content: [{ type: "text",
      text: [1, 2, 3, 4].map(id => `@[Tab](dsh-browser://runtime/${id})`).join(" ") }] };
    const decision = await root.waterfall("agent/pre-step", { agent },
      () => Promise.resolve({ kind: "enter", messages: [user] }));
    const context = decision.messages[0].content.at(-1).text;
    assert.equal(reads.length, 4);
    assert.ok(reads[0] < 600 && reads.every(limit => limit >= 400 && limit < 2400));
    assert.ok(context.length <= 2400, `shared budget exceeded: ${context.length}`);
    BrowserBridge.prototype.resolve = ref => {
      if (ref !== "dsh-browser://runtime/1") throw new Error("Old tab is offline");
      return { tab: { ref } };
    };
    const current = await tools.get("browser_read").execute({}, { agent });
    assert.equal(current.tab, "dsh-browser://runtime/1", "old grants must not obscure the only live tab");
    await fiber.dispose();
    console.log("PASS: initial context shares one budget across referenced tabs, including escaping.");
  } else if (process.argv[3] === "routing") {
    const events = [];
    WebMCP.prototype.list = async ref => {
      events.push(`discover:${ref}`);
      return { tab: ref, supported: true, catalog: "native-tools", tools: ref.endsWith("/1")
        ? [{ name: "read_page", available: true, inputSchema: { type: "object" } }] : [], omitted: 0 };
    };
    BrowserEngine.prototype.read = async ref => {
      events.push(`dom:${ref}`);
      return { tab: ref, snapshot: "dom", content: "Page text" };
    };
    const fiber = root.plugin(plugin);
    await fiber.await();
    const agent = { session: { id: "routing-session" } };
    const refs = ["dsh-browser://runtime/1", "dsh-browser://runtime/2"];
    const user = { id: "routing-message", source: { kind: "user" }, content: [{ type: "text",
      text: refs.map(ref => `@[Tab](${ref})`).join(" ") }] };
    const decision = await root.waterfall("agent/pre-step", { agent },
      () => Promise.resolve({ kind: "enter", messages: [user] }));
    assert.deepEqual(events, [`discover:${refs[0]}`, `discover:${refs[1]}`, `dom:${refs[1]}`]);
    const context = decision.messages[0].content.at(-1).text;
    assert.ok(context.length <= 2400);
    assert.match(context, /native-tools/);
    assert.match(context, /browser_webmcp_call/);
    const read = tools.get("browser_read");
    assert.equal((await read.execute({ tab: refs[0] }, { agent })).catalog, "native-tools");
    const count = events.length;
    assert.equal((await read.execute({ tab: refs[0], mode: "dom" }, { agent })).snapshot, "dom");
    assert.deepEqual(events.slice(count), [`dom:${refs[0]}`]);
    await root.waterfall("agent/pre-step", { agent },
      () => Promise.resolve({ kind: "enter", messages: [user] }));
    assert.equal(events.length, count + 1, "replaying a prepared user message must not read or discover again");
    await fiber.dispose();
    console.log("PASS: host context and browser_read discover WebMCP before DOM and allow intentional fallback.");
  } else if (process.argv[3] === "grants") {
    // DSH claims one input batch per step, so only the step that carries the user
    // message sees the citation; every later step must keep the grant.
    const agent = { session: { id: "test-session" } };
    const ref = "dsh-browser://profile-1/42";
    const preStep = (messages, step) => root.waterfall("agent/pre-step", { agent, messages, step },
      () => Promise.resolve({ kind: "enter", messages }));
    const first = root.plugin(plugin);
    await first.await();
    const user = { id: "m1", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: `look at @[Example](${ref})` }] };
    await preStep([user], 1);
    const tool = { id: "m2", role: "tool", source: { kind: "tool" }, content: [{ type: "text", text: "{}" }] };
    await preStep([tool], 2);
    await preStep([tool], 3);
    const read = tools.get("browser_read");
    await assert.rejects(async () => read.execute({ tab: ref, limit: 400 }, { agent }), /offline/i);
    await assert.rejects(async () => read.execute({ tab: "dsh-browser://profile-1/99", limit: 400 }, { agent }), /not referenced by the user/i);
    const webmcpList = tools.get("browser_webmcp_list");
    const webmcpCall = tools.get("browser_webmcp_call");
    assert.equal(webmcpList.presentCall({}).kind, "read");
    assert.equal(webmcpCall.presentCall({}).kind, "other", "site hints must not downgrade execution to a read tool");
    await assert.rejects(async () => webmcpList.execute({ tab: "dsh-browser://profile-1/99" }, { agent }), /not referenced by the user/i);
    await assert.rejects(async () => webmcpCall.execute({ tab: "dsh-browser://profile-1/99", catalog: "test", name: "test" }, { agent }), /not referenced by the user/i);
    await first.dispose();
    // A new activation (a DSH restart) reloads the conversation's grants.
    const second = root.plugin(plugin);
    await second.await();
    await assert.rejects(async () => tools.get("browser_read").execute({ tab: ref, limit: 400 }, { agent }), /offline/i);
    await second.dispose();
    console.log("PASS: a cited tab stays authorized for the conversation across steps and restarts.");
  } else {
    if (rejectRegistration) {
      const failed = root.plugin(plugin);
      await assert.rejects(failed.await(), /Test registration failure/);
      await failed.dispose();
      const released = await openPort(port);
      await closePort(released);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const fiber = root.plugin(plugin);
      await fiber.await();
      const setup = await fiber.ctx.browserTabs.setup();
      assert.equal((await fetch(setup.url)).status, 200);
      await fiber.dispose();
      const released = await openPort(port);
      await closePort(released);
    }
    console.log("PASS: DSH bridge lifecycle releases the port after unload or failed activation.");
  }
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  await root.fiber.dispose();
  process.exitCode = failed ? 1 : 0;
}
