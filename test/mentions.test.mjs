import { test } from "node:test";
import assert from "node:assert/strict";
import { compactReferences, referenceQuery } from "../src/reference-folders.js";
import { usefulWindows } from "../src/apps/windows.js";
import { AppInventory } from "../src/apps/processes.js";
import { apply as applyClient } from "../src/client.js";

function references() {
  return ["file", "session"].flatMap(kind => Array.from({ length: 9 }, (_, index) => ({ name: `${kind} ${index}`, section: kind === "file" ? "文件" : "对话",
    icon: kind === "file" ? "file" : "session", value: JSON.stringify({ kind, mention: `@${kind}-${index}`, fileKind: "file" }) })));
}

function registry() {
  const live = { sources: [] };
  return { live, registerSource(source) { live.sources.push(source); return () => live.sources.splice(live.sources.indexOf(source), 1); } };
}

test("native files and conversations collapse independently and keep original reference owners", async () => {
  const service = registry(); const items = references(); const picks = [];
  const source = { name: "reference", trigger: "@", codec: {}, candidates: async () => items,
    onPick: request => { picks.push(request); return { insert: { source: "reference", ref: JSON.parse(request.candidate.value).mention } }; }, header: () => ["original"] };
  service.registerSource(source); const originals = { ...source }; const restore = compactReferences(service);
  const root = await source.candidates({}, { query: "" });
  assert.equal(root.length, 8); assert.equal(root.filter(item => JSON.parse(item.value).kind === "file").length, 3);
  assert.equal(root.filter(item => JSON.parse(item.value).kind === "session").length, 3);
  const expand = root.find(item => item.name === "展开文件（9）");
  const outcome = source.onPick({ candidate: expand, action: "pick" }); assert.deepEqual(outcome, { text: "@文件:", continue: true });
  const files = await source.candidates({}, { query: "文件:", drilled: true }); assert.equal(files.length, 10);
  assert.equal(files[0].name, "收起文件"); assert.equal(files.slice(1).every(item => JSON.parse(item.value).kind === "file"), true);
  assert.deepEqual(source.onPick({ candidate: files[0] }), { text: "@", continue: true });
  assert.deepEqual(source.onPick({ candidate: files[1], action: "pick" }), { insert: { source: "reference", ref: "@file-0" } });
  assert.equal(picks.length, 1); assert.equal(source.codec, originals.codec);
  assert.equal((await source.candidates({}, { query: "对话:" })).slice(1).every(item => JSON.parse(item.value).kind === "session"), true);
  assert.equal(source.header({}, { query: "文件:" })[0].label, "文件");
  assert.equal(files[0].drill, undefined, "collapse must use a normal pick so DSH restores other @ sources");
  restore(); assert.equal(source.candidates, originals.candidates); assert.equal(source.onPick, originals.onPick); assert.equal(source.header, originals.header);
});

test("keyword searches, quoted paths and folder drilling are not folded or rewritten", async () => {
  const service = registry(); const items = references(); const requests = [];
  const source = { trigger: "@", name: "reference", candidates: async (_session, request) => { requests.push(request); return items; }, onPick: () => ({ text: "@directory/", continue: true }) };
  service.registerSource(source); const restore = compactReferences(service);
  for (const request of [{ query: "readme" }, { query: "", quoted: true }, { query: "", drilled: true }, { query: "src/", drilled: true }]) {
    assert.equal(await source.candidates({}, request), items); assert.equal(requests.at(-1), request);
  }
  await source.candidates({}, { query: "文件:src/" }); assert.equal(requests.at(-1).query, "src/");
  assert.deepEqual(source.onPick({ candidate: items[0], action: "drill" }), { text: "@directory/", continue: true });
  restore(); assert.equal(Object.hasOwn(source, "header"), false);
});

test("reference folding handles late registration, ignores other plugins and restores the registry", async () => {
  const service = registry(); const register = service.registerSource;
  const other = { name: "someone-else", trigger: "@", candidates: async () => references() };
  service.registerSource(other); const candidates = other.candidates;
  const restore = compactReferences(service);
  const source = { name: "reference", trigger: "@", candidates: async () => references(), onPick: () => undefined };
  const original = source.candidates; service.registerSource(source);
  assert.equal((await source.candidates({}, { query: "" })).length, 8); assert.equal(other.candidates, candidates);
  restore(); assert.equal(source.candidates, original); assert.equal(service.registerSource, register);
  assert.doesNotThrow(() => compactReferences({ registerSource() {} })());
});

test("@file aliases open native file categories instead of searching for the category name", async () => {
  const service = registry(), items = references(), requests = [];
  const source = { name: "reference", trigger: "@", candidates: async (_session, request) => {
    requests.push(request); return request.query === "" ? items : [];
  }, onPick: ({ candidate }) => ({ insert: { source: "reference", ref: JSON.parse(candidate.value).mention } }) };
  service.registerSource(source); const restore = compactReferences(service);
  for (const query of ["文件", "file", "files", "文件：", "Files:"]) {
    const rows = await source.candidates({}, { query });
    assert.equal(rows.length, 10, query); assert.equal(requests.at(-1).query, "");
    assert.equal(rows[0].name, "收起文件");
    assert.equal(source.onPick({ candidate: rows[1] }).insert.source, "reference");
  }
  assert.equal(referenceQuery("文件夹").kind, "folder"); assert.equal(referenceQuery("对话").kind, "session");
  assert.equal(referenceQuery("file-name.js"), undefined, "ordinary filenames are not category aliases");
  assert.equal(referenceQuery("文件.txt"), undefined);
  assert.equal(referenceQuery("文件:src/index.js").query, "src/index.js");
  restore();
});

test("native references registered after browser/app sources remain first and restore order on unload", () => {
  const service = registry();
  service.registerSource({ name: "browser-tabs", trigger: "@" });
  service.registerSource({ name: "desktop-apps", trigger: "@" });
  const restore = compactReferences(service);
  const source = { name: "reference", trigger: "@", candidates: async () => references(), onPick() {} };
  service.registerSource(source);
  assert.equal([...service.live.sources].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0], source);
  restore(); assert.equal(Object.hasOwn(source, "order"), false);
});

test("bare @ keeps a file-search entry even when native results contain only folders and conversations", async () => {
  const service = registry();
  const native = references().filter(item => JSON.parse(item.value).kind === "session");
  const source = { name: "reference", trigger: "@", candidates: async () => native, onPick() {} };
  service.registerSource(source); const restore = compactReferences(service);
  const items = await source.candidates({}, { query: "" });
  assert.equal(items[0].section, "文件"); assert.equal(items[0].name, "搜索文件");
  assert.deepEqual(source.onPick({ candidate: items[0], action: "pick" }), { text: "@文件:", continue: true });
  assert.equal(items.filter(item => JSON.parse(item.value).kind === "session").length, 3);
  restore();
});

test("file/conversation expansion does not mix in app, annotation or browser setup rows", async () => {
  const sources = []; let calls = 0;
  applyClient({ effect: fn => fn(), inputTriggers: { registerSource: source => sources.push(source) }, remote: { $mount() {} }, get: () => new Proxy({}, { get: () => () => { calls++; throw Error("should not call"); } }) }, { browserIcon() {}, tabIcon() {} });
  for (const name of ["browser-tabs", "desktop-apps"]) for (const query of ["文件:", "文件夹:", "对话:"]) {
    assert.deepEqual(await sources.find(source => source.name === name).candidates({}, { query }), []);
  }
  assert.equal(calls, 0); assert.equal(referenceQuery("文件:readme").query, "readme");
});

test("@ folders get their own expansion group and retain native directory drill and folder insertion", async () => {
  const service = registry(); const folders = Array.from({ length: 7 }, (_, i) => ({ name: `dir-${i}/`, section: "文件", icon: "folder", drill: true,
    value: JSON.stringify({ kind: "file", fileKind: "directory", mention: `@dir-${i}/` }) }));
  const source = { trigger: "@", name: "reference", candidates: async () => [...folders, ...references()],
    onPick: ({ candidate, action }) => action === "drill" ? { text: JSON.parse(candidate.value).mention, continue: true } : { insert: { appearance: "folder", ref: JSON.parse(candidate.value).mention } } };
  service.registerSource(source); const restore = compactReferences(service);
  const root = await source.candidates({}, { query: "" });
  const expand = root.find(item => item.name === "展开文件夹（7）"); assert.ok(expand);
  assert.deepEqual(source.onPick({ candidate: expand }), { text: "@文件夹:", continue: true });
  const listing = await source.candidates({}, { query: "文件夹:", drilled: true });
  assert.equal(listing.length, 8); assert.equal(listing[0].name, "收起文件夹");
  assert.deepEqual(source.onPick({ candidate: listing[1], action: "drill" }), { text: "@dir-0/", continue: true });
  assert.equal(source.onPick({ candidate: listing[1], action: "pick" }).insert.appearance, "folder");
  const files = await source.candidates({}, { query: "文件:" }); assert.equal(files.length, 10);
  assert.equal(files.slice(1).some(item => JSON.parse(item.value).fileKind === "directory"), false);
  restore();
});

const windowRow = (changes = {}) => ({ pid: 42, windowId: "123", name: "Unity", title: "Scene", path: "C:\\Apps\\Unity.exe", started: "1",
  visible: true, width: 1200, height: 800, zOrder: 5, ...changes });

test("app inventory keeps real exe windows and excludes shell, tray and helper surfaces", () => {
  const rows = [windowRow(),
    windowRow({ pid: 1, windowId: "1", visible: false }), windowRow({ pid: 2, windowId: "2", cloaked: true }),
    windowRow({ pid: 3, windowId: "3", toolWindow: true }), windowRow({ pid: 4, windowId: "4", noActivate: true }),
    windowRow({ pid: 5, windowId: "5", name: "TextInputHost" }), windowRow({ pid: 6, windowId: "6", className: "Progman" }),
    windowRow({ pid: 7, windowId: "7", path: "C:\\Apps\\background.dll" }), windowRow({ pid: 8, windowId: "8", title: " " }),
    windowRow({ pid: 9, windowId: "9", width: 10 }), windowRow({ pid: 10, windowId: "10", path: null }),
    windowRow({ pid: 11, windowId: "11", height: 0 }), windowRow({ pid: 12, windowId: "0" })];
  assert.deepEqual(usefulWindows(rows).map(row => row.pid), [42]);
});

test("app inventory preserves multiple windows, minimized apps and foreground order without duplicates", async () => {
  const rows = [windowRow(), windowRow(), windowRow({ windowId: "124", title: "Another project", foreground: true, zOrder: 0 }),
    windowRow({ pid: 9, windowId: "9", name: "explorer", path: "C:\\Windows\\explorer.exe", className: "CabinetWClass", title: "Documents", minimized: true, width: 0, height: 0 })];
  const filtered = usefulWindows(rows); assert.deepEqual(filtered.map(row => row.windowId), ["124", "123", "9"]);
  const inventory = new AppInventory({ inventory: async () => filtered });
  const matches = await inventory.list("Unity.exe"); assert.equal(matches.length, 2); assert.notEqual(matches[0].ref, matches[1].ref);
  assert.equal((await inventory.resolve(matches[0].ref)).windowId, "124");
});

test("application mention labels identify both the executable and selected window", async () => {
  const sources = [];
  applyClient({ effect: fn => fn(), inputTriggers: { registerSource: source => sources.push(source) }, remote: { $mount() {} }, get: () => ({ apps: async () => ({ ok: true, value: { apps: [windowRow({ ref: "dsh-app://fixture/window", product: "Unity Tools", displayName: "Unity Editor" })] } }) }) }, { browserIcon() {}, tabIcon() {} });
  const source = sources.find(source => source.name === "desktop-apps"); const [item] = await source.candidates({}, { query: "Unity" });
  assert.equal(item.name, "Unity Editor"); assert.equal(item.description, "Scene");
  assert.equal(source.onPick({ candidate: item }).insert.label, "Unity Editor · Scene");
});
