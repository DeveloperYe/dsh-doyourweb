import { test } from "node:test";
import assert from "node:assert/strict";
import { AppIcons } from "../src/apps/icons.js";
import { apply as applyClient } from "../src/client.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg==";

test("app windows and overlapping menu queries share one cached executable icon", async () => {
  const batches = [];
  const icons = new AppIcons({ read: async files => { batches.push(files); return { [files[0]]: png }; } });
  const apps = [{ path: "E:\\Apps\\Unity.exe", windowId: "1" }, { path: "e:\\apps\\unity.EXE", windowId: "2" }];
  const [first, second] = await Promise.all([icons.decorate(apps), icons.decorate(apps)]);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(file => file.toLowerCase()), [apps[0].path.toLowerCase()]);
  assert.ok([...first, ...second].every(app => app.icon === png));
  await icons.decorate(apps);
  assert.equal(batches.length, 1);
  assert.equal(apps[0].icon, undefined, "UI decoration does not add image data to app identity/context");
});

test("failed icon reads retain app candidates without repeated extraction or remote image URLs", async () => {
  let reads = 0;
  const icons = new AppIcons({ read: async () => { reads++; throw new Error("unreadable executable"); } });
  const apps = [{ path: "E:\\Apps\\Editor.exe", name: "Editor" }];
  assert.equal((await icons.decorate(apps))[0].name, "Editor");
  assert.equal((await icons.decorate(apps))[0].icon, undefined);
  assert.equal(reads, 1);
  const invalid = new AppIcons({ read: async files => ({ [files[0]]: "https://example.com/icon.png" }) });
  assert.equal((await invalid.decorate(apps))[0].icon, undefined);
});

test("@ app candidates use the program icon while app management uses the generic icon", async () => {
  const sources = [], generic = () => null, specific = () => null;
  const app = { ref: "dsh-app://00000000-0000-0000-0000-000000000000/123456789012345678901234", name: "Editor", title: "Window", icon: png };
  const remote = { apps: async () => ({ ok: true, value: { apps: [app] } }) };
  applyClient({ effect: fn => fn(), remote: { $mount() {} }, get: () => remote,
    inputTriggers: { registerSource: source => sources.push(source) } }, {
    browserIcon: () => null, appIcon: generic, applicationIcon: item => { assert.equal(item.icon, png); return specific; },
  });
  const source = sources.find(s => s.name === "desktop-apps");
  const [candidate] = await source.candidates({}, { query: "程序" });
  assert.equal(candidate.icon, specific);
  assert.equal(source.onPick({ candidate }).insert.source, "desktop-apps");
  assert.equal(candidate.value.includes(png), false);
  const [manage] = await sources.find(s => s.name === "doyourweb-manage").candidates({}, {});
  assert.equal(manage.icon, generic);
});
