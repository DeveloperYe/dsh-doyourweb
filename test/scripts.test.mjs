import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

test("contract extraction does not delete unrelated files in --out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-extract-test-"));
  const output = path.join(root, "extract");
  try {
    await mkdir(output);
    await writeFile(path.join(output, "keep.txt"), "preserve me");
    const archive = path.join(root, "bad.asar");
    await writeFile(archive, Buffer.alloc(16));
    const script = fileURLToPath(new URL("../scripts/verify-dsh-contract.mjs", import.meta.url));
    assert.equal(path.dirname(path.resolve(output)), root);
    await assert.rejects(promisify(execFile)(process.execPath, [script, "--asar", archive, "--out", output], { timeout: 5000 }));
    assert.equal(await readFile(path.join(output, "keep.txt"), "utf8"), "preserve me");
    const repository = fileURLToPath(new URL("..", import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, [script, "--asar", archive, "--out", repository], { timeout: 5000 }),
      /dedicated directory/);
  } finally {
    assert.equal(path.dirname(output), root);
    assert.ok(path.basename(root).startsWith("dsh-extract-test-"));
    await rm(root, { recursive: true, force: true });
  }
});
