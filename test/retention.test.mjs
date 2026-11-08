import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneDirectory } from "../src/retention.js";

const DAY = 24 * 60 * 60 * 1000;

/** Create `count` files a minute apart, oldest first, so mtime order is unambiguous. */
async function seed(dir, count, ageDays = 0) {
  await writeFile(path.join(dir, ".keepme"), "x"); // a stray file: it is a file too
  const base = Date.now() - ageDays * DAY;
  for (let index = 0; index < count; index += 1) {
    const file = path.join(dir, `f${String(index).padStart(3, "0")}.json`);
    await writeFile(file, "{}");
    // Later index = newer file; a minute apart so coarse filesystem timestamps keep them distinct.
    const at = new Date(base - (count - index) * 60_000);
    await utimes(file, at, at);
  }
}

test("only the newest files survive the count limit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-retention-count-"));
  try {
    await seed(dir, 10);
    // Names sort opposite to age, so deletion must follow mtime, not the name.
    const newest = path.join(dir, "f009.json");
    // Age the stray file so it is unambiguously the oldest candidate.
    const old = new Date(Date.now() - 10 * DAY);
    await utimes(path.join(dir, ".keepme"), old, old);
    const result = await pruneDirectory(dir, { keep: 3 });
    const left = (await readdir(dir)).sort();
    assert.equal(result.kept, 3);
    assert.equal(result.removed.length, 8, "11 files in total, three survive");
    assert.equal(left.includes(path.basename(newest)), true, "the newest file is always kept");
    assert.equal(left.includes(".keepme"), false, "cleanup does not special-case names");
    assert.equal(left.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("files older than the age limit go even when the count would allow them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-retention-age-"));
  try {
    await seed(dir, 4, 0);
    const stale = path.join(dir, "stale.json");
    await writeFile(stale, "{}");
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(stale, old, old);

    const result = await pruneDirectory(dir, { keep: 100, maxAgeDays: 30 });
    const left = await readdir(dir);
    assert.equal(result.removed.includes("stale.json"), true, "the stale file is removed");
    assert.equal(left.includes("stale.json"), false);
    assert.equal(left.filter(name => name !== ".keepme").length, 4, "fresh files are untouched");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a missing or unreadable directory is not an error", async () => {
  // A failed cleanup must never fail the tool call that triggered it.
  const missing = path.join(os.tmpdir(), `dsh-retention-missing-${Date.now()}`);
  assert.deepEqual(await pruneDirectory(missing, { keep: 1 }), { removed: [], kept: 0 });
  assert.deepEqual(await pruneDirectory(undefined, { keep: 1 }), { removed: [], kept: 0 });
});

test("the shipped limits keep the folders small", async () => {
  const { CAPTURE_KEEP, ANNOTATION_KEEP, CAPTURE_MAX_AGE_DAYS, ANNOTATION_MAX_AGE_DAYS } = await import("../src/retention.js");
  assert.ok(CAPTURE_KEEP > 0 && CAPTURE_KEEP <= 500, "screenshots are capped by count");
  assert.ok(ANNOTATION_KEEP >= CAPTURE_KEEP, "tiny annotation files may keep more");
  assert.ok(CAPTURE_MAX_AGE_DAYS <= 30 && ANNOTATION_MAX_AGE_DAYS <= 90, "and by age as well");
});
