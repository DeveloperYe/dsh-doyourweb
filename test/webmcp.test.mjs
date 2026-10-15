import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserEngine } from "../src/engine.js";
import { WebMCP } from "../src/webmcp.js";
import { serialize } from "../src/output.js";

function fixture({ supported = true, schema, execute } = {}) {
  let calls = 0;
  let discoveries = 0;
  let handle;
  const document = { url: "https://example.com/", epoch: 1 };
  const context = new EventTarget();
  context.executeTool = async (_tool, args, options) => {
    calls++;
    return execute ? execute(args, options) : JSON.stringify({ value: args.value });
  };
  const page = {
    evaluate: async () => ({ ...document }),
    evaluateHandle: async () => {
      discoveries++;
      const state = { supported, context, changed: false, total: 1, tools: [{
        name: "test_tool", description: "Test tool", origin: "https://example.com",
        inputSchema: schema || { type: "object", properties: { value: { type: "number" } },
          required: ["value"], additionalProperties: false }, annotations: {},
      }] };
      handle = { state, disposed: false,
        async evaluate(fn, arg) { if (this.disposed) throw new Error("Disposed handle"); return fn(state, arg); },
        async dispose() { this.disposed = true; } };
      return handle;
    },
  };
  const bridge = new EventEmitter();
  bridge.page = async () => page;
  const engine = new BrowserEngine(bridge);
  const webmcp = new WebMCP(engine);
  return { webmcp, engine, bridge, document, calls: () => calls, discoveries: () => discoveries, handle: () => handle };
}

test("WebMCP reports unsupported pages without injecting tools", async () => {
  const f = fixture({ supported: false });
  const result = await f.webmcp.list("tab");
  assert.equal(result.supported, false);
  assert.deepEqual(result.tools, []);
  assert.match(result.fallback, /browser_read/);
  assert.equal(f.calls(), 0);
  assert.equal(f.handle().disposed, false, "negative discovery is cached until navigation or idle release");
  await f.webmcp.close();
  assert.equal(f.handle().disposed, true);
});

test("WebMCP validates input before execution and consumes a catalog once", async () => {
  const f = fixture();
  const list = await f.webmcp.list("tab");
  assert.equal(list.tools[0].name, "test_tool");
  const call = { catalog: list.catalog, name: "test_tool", arguments: { value: "wrong" } };
  await assert.rejects(f.webmcp.call("tab", call), /arguments/i);
  assert.equal(f.calls(), 0);
  f.engine.states.set("tab", { id: "old-aria-snapshot" });
  const result = await f.webmcp.call("tab", { ...call, arguments: { value: 4 } });
  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.result), { value: 4 });
  assert.equal(result.untrusted, true);
  assert.ok(result.nextCatalog, "successful calls return a fresh single-use token without repeating schemas");
  assert.equal(f.engine.states.has("tab"), false);
  await assert.rejects(f.webmcp.call("tab", call), /catalog/i);
  assert.equal(f.calls(), 1);
  assert.equal(f.handle().disposed, false);
  const next = await f.webmcp.call("tab", { ...call, catalog: result.nextCatalog, arguments: { value: 5 } });
  assert.equal(next.status, "completed");
  assert.equal(f.discoveries(), 1, "a successful chain must not rediscover or recompile tools");
  await f.webmcp.close();
  assert.equal(f.handle().disposed, true);
});

test("automatic reading prefers WebMCP and only reads DOM when needed", async () => {
  const f = fixture();
  let reads = 0;
  f.engine.read = async () => { reads++; return { snapshot: "dom", content: "Page text" }; };
  const catalog = await f.webmcp.read("tab");
  assert.equal(catalog.tab, "tab");
  assert.equal(catalog.tools[0].name, "test_tool");
  assert.equal(reads, 0, "WebMCP pages must not also produce an initial ARIA snapshot");
  const repeated = await f.webmcp.read("tab");
  assert.equal(repeated.catalog, catalog.catalog);
  assert.equal(f.discoveries(), 1);
  const dom = await f.webmcp.read("tab", { mode: "dom", selector: "main" });
  assert.equal(dom.snapshot, "dom");
  assert.equal(reads, 1, "an unrelated site tool must not prevent intentional DOM fallback");
  assert.equal(f.discoveries(), 1);
  await f.webmcp.close();
});

test("unsupported, empty and unusable catalogs fall back to DOM and cache discovery", async () => {
  for (const kind of ["unsupported", "empty", "consequential", "invalid"]) {
    const f = fixture({ supported: kind !== "unsupported",
      ...(kind === "invalid" ? { schema: { type: "not-a-schema-type" } } : {}) });
    const discover = f.engine.bridge.page;
    const page = await discover();
    const evaluateHandle = page.evaluateHandle;
    page.evaluateHandle = async (...args) => {
      const handle = await evaluateHandle(...args);
      if (kind === "empty") { handle.state.tools = []; handle.state.total = 0; }
      if (kind === "consequential") handle.state.tools[0].annotations.consequentialHint = true;
      return handle;
    };
    let reads = 0;
    f.engine.read = async () => { reads++; return { snapshot: "dom" }; };
    assert.equal((await f.webmcp.read("tab")).snapshot, "dom", kind);
    assert.equal((await f.webmcp.read("tab")).snapshot, "dom", kind);
    assert.equal(reads, 2);
    assert.equal(f.discoveries(), 1, kind);
    f.document.epoch++;
    await f.webmcp.read("tab");
    assert.equal(f.discoveries(), 2, "navigation must invalidate negative results too");
    await f.webmcp.close();
  }
});

test("cached discovery respects query, output budget, tool changes and idle release", async () => {
  const f = fixture();
  const first = await f.webmcp.list("tab", { limit: 400 });
  assert.ok(serialize(first).length <= 400);
  const second = await f.webmcp.list("tab", { limit: 8000 });
  assert.equal(second.catalog, first.catalog);
  assert.equal(second.tools[0].available, true);
  assert.equal(f.discoveries(), 1);
  f.handle().state.changed = true;
  const changed = await f.webmcp.list("tab");
  assert.notEqual(changed.catalog, first.catalog);
  assert.equal(f.discoveries(), 2);
  await f.webmcp.list("tab", { query: "test_tool" });
  assert.equal(f.discoveries(), 3);
  f.bridge.emit("release", "tab");
  await f.webmcp.list("tab");
  assert.equal(f.discoveries(), 4);
  await f.webmcp.close();
});

test("a successful tool that changes registrations cannot hand out a reusable catalog", async () => {
  let f;
  f = fixture({ execute: () => { f.handle().state.changed = true; return "done"; } });
  const list = await f.webmcp.list("tab");
  const result = await f.webmcp.call("tab", { catalog: list.catalog, name: "test_tool", arguments: { value: 1 } });
  assert.equal(result.status, "completed");
  assert.equal(result.nextCatalog, undefined);
  assert.equal(f.handle().disposed, true);
  await f.webmcp.close();
});

test("uncertain execution forces state inspection instead of suggesting another call", async () => {
  const f = fixture();
  f.engine.receipts.set("tab", { kind: "webmcp", mayHaveLateEffects: true });
  f.engine.read = async () => ({ snapshot: "inspect", lastAction: f.engine.receipts.get("tab") });
  const read = await f.webmcp.read("tab");
  assert.equal(read.snapshot, "inspect");
  assert.equal(read.lastAction.mayHaveLateEffects, true);
  assert.equal(f.discoveries(), 0);
  assert.equal(f.calls(), 0);
  await f.webmcp.close();
});

test("WebMCP rejects stale documents, changed registrations and foreign catalogs", async () => {
  const f = fixture();
  let list = await f.webmcp.list("tab");
  const call = () => ({ catalog: list.catalog, name: "test_tool", arguments: { value: 1 } });
  await assert.rejects(f.webmcp.call("other-tab", call()), /catalog/i);
  f.document.epoch++;
  await assert.rejects(f.webmcp.call("tab", call()), /stale/i);
  list = await f.webmcp.list("tab");
  f.handle().state.changed = true;
  await assert.rejects(f.webmcp.call("tab", call()), /changed/i);
  list = await f.webmcp.list("tab");
  f.bridge.emit("release", "tab");
  await assert.rejects(f.webmcp.call("tab", call()), /catalog/i);
  assert.equal(f.calls(), 0);
  await f.webmcp.close();
});

test("WebMCP bounds catalogs and results without corrupting input schemas", async () => {
  const f = fixture({ execute: () => "<".repeat(20000) });
  const list = await f.webmcp.list("tab", { limit: 800 });
  assert.ok(serialize(list).length <= 800);
  assert.equal(list.tools[0].inputSchema.properties.value.type, "number");
  const result = await f.webmcp.call("tab", {
    catalog: list.catalog, name: "test_tool", arguments: { value: 2 }, limit: 400,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.truncated, true);
  assert.ok(serialize(result).length <= 400);
  await f.webmcp.close();
});

test("WebMCP timeout aborts the page call and reports potentially late effects", async () => {
  let aborted = false;
  const f = fixture({ execute: (_args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  const list = await f.webmcp.list("tab");
  const result = await f.webmcp.call("tab", {
    catalog: list.catalog, name: "test_tool", arguments: { value: 1 }, timeout: 20,
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.mayHaveLateEffects, true);
  assert.equal(result.nextCatalog, undefined);
  assert.equal(aborted, true);
  assert.equal(f.handle().disposed, true);
  assert.equal(f.engine.receipts.get("tab").mayHaveLateEffects, true);
  assert.equal(f.calls(), 1);
  await f.webmcp.close();
});

test("WebMCP refuses consequential tools and invalid schemas", async () => {
  const f = fixture();
  const list = await f.webmcp.list("tab");
  f.handle().state.tools[0].annotations.consequentialHint = true;
  await assert.rejects(f.webmcp.call("tab", {
    catalog: list.catalog, name: "test_tool", arguments: { value: 1 },
  }), /consequential/i);
  assert.equal(f.calls(), 0);
  await f.webmcp.close();

  const invalid = fixture({ schema: { type: "not-a-json-schema-type" } });
  const invalidList = await invalid.webmcp.list("tab");
  assert.equal(invalidList.tools[0].available, false);
  await assert.rejects(invalid.webmcp.call("tab", {
    catalog: invalidList.catalog, name: "test_tool", arguments: {},
  }), /schema/i);
  assert.equal(invalid.calls(), 0);
  await invalid.webmcp.close();
});

test("WebMCP accepts repeated schema ids without leaking validators between catalogs", async () => {
  const f = fixture({ schema: { $id: "https://example.com/input", type: "object", properties: { value: { type: "number" } } } });
  const first = await f.webmcp.list("tab");
  const second = await f.webmcp.list("tab", { query: "test_tool" });
  assert.notEqual(second.catalog, first.catalog, "a new query creates a separate catalog");
  assert.equal(first.tools[0].available, true);
  assert.equal(second.tools[0].available, true);
  const result = await f.webmcp.call("tab", { catalog: second.catalog, name: "test_tool", arguments: { value: 2 } });
  assert.equal(result.status, "completed");
  await f.webmcp.close();
});

test("WebMCP validates draft-2020-12 input schemas", async () => {
  const f = fixture({ schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false } });
  const list = await f.webmcp.list("tab");
  assert.equal(list.tools[0].available, true);
  await assert.rejects(f.webmcp.call("tab", { catalog: list.catalog, name: "test_tool", arguments: { value: "bad" } }), /arguments/i);
  const result = await f.webmcp.call("tab", { catalog: list.catalog, name: "test_tool", arguments: { value: 2 } });
  assert.equal(result.status, "completed");
  assert.equal(f.calls(), 1);
  await f.webmcp.close();
});

test("WebMCP cancellation forwards abort and already cancelled calls do not attach", async () => {
  let attached = 0;
  const engine = new BrowserEngine({ page: async () => { attached++; throw new Error("must not attach"); } });
  const idle = new WebMCP(engine);
  await assert.rejects(idle.list("tab", {}, AbortSignal.abort()), /abort/i);
  await assert.rejects(idle.call("tab", {}, AbortSignal.abort()), /abort/i);
  assert.equal(attached, 0);
  await idle.close();

  const controller = new AbortController();
  let aborted = false;
  const f = fixture({ execute: (_args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    controller.abort();
  }) });
  const list = await f.webmcp.list("tab");
  const result = await f.webmcp.call("tab", {
    catalog: list.catalog, name: "test_tool", arguments: { value: 1 },
  }, controller.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(result.mayHaveLateEffects, true);
  assert.equal(aborted, true);
  assert.equal(f.calls(), 1);
  await f.webmcp.close();
});

test("WebMCP blocks a registration change between preflight and dispatch", async () => {
  const f = fixture();
  const list = await f.webmcp.list("tab");
  const handle = f.handle();
  const evaluate = handle.evaluate.bind(handle);
  handle.evaluate = async (fn, arg) => {
    const result = await evaluate(fn, arg);
    if (result && typeof result.changed === "boolean") handle.state.changed = true;
    return result;
  };
  const result = await f.webmcp.call("tab", { catalog: list.catalog, name: "test_tool", arguments: { value: 1 } });
  assert.equal(result.status, "error");
  assert.equal(f.calls(), 0);
  await f.webmcp.close();
});
