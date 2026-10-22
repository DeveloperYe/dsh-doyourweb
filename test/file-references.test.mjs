import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { balanceFileReferences } from "../src/file-references.js";

test("root file candidates cannot be starved by a directory-only native limit", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-file-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "directory"));
  for (const file of ["README.md", "notes.txt", ".private"]) await writeFile(path.join(root, file), "");
  const directories = Array.from({ length: 20 }, (_, i) => ({ path: `dir-${i}`, kind: "directory" }));
  const requests = [];
  const service = { config: { maxResults: 20, excludedDirectories: [] }, async list(agent, query, signal) {
    requests.push({ owner: this, agent, query, signal }); return directories;
  } };
  const original = service.list, agent = {}, signal = new AbortController().signal;
  const restore = balanceFileReferences(service, { ensure: async () => root });
  const result = await service.list(agent, "", signal);
  assert.equal(result.length, 20); assert.equal(result.filter(row => row.kind === "directory").length, 18);
  assert.deepEqual(result.filter(row => row.kind === "file").map(row => row.path), ["README.md", "notes.txt"]);
  assert.equal(requests[0].owner, service); assert.equal(requests[0].agent, agent); assert.equal(requests[0].signal, signal);
  assert.equal(await service.list(agent, "src/", signal), directories, "directory and keyword searches remain native");
  restore(); assert.equal(service.list, original);
});

test("file balancing does not read unrelated roots or interfere with native files and failures", async () => {
  const native = [{ path: "README.md", kind: "file" }];
  const service = { config: { maxResults: 20, excludedDirectories: [] }, list: async () => native };
  const restore = balanceFileReferences(service, { ensure: async () => { throw new Error("unexpected directory lookup"); } });
  const signal = new AbortController().signal;
  assert.equal(await service.list({}, "", signal), native);
  restore();
  assert.doesNotThrow(() => balanceFileReferences({ list() {} }, {})());
});
