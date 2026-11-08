/**
 * Retention for the files this plugin writes for the model: screenshots and annotation
 * payloads. Both used to grow without limit (36 screenshots = 9 MB on a machine that had
 * only been annotating for an evening), so every write now trims the directory.
 */

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const CAPTURE_KEEP = 100;
export const CAPTURE_MAX_AGE_DAYS = 14;
export const ANNOTATION_KEEP = 200;
export const ANNOTATION_MAX_AGE_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Keep the newest `keep` files and drop anything older than `maxAgeDays`.
 * Never throws: a failed cleanup must not break the tool call that triggered it.
 *
 * @returns {Promise<{ removed: string[], kept: number }>}
 */
export async function pruneDirectory(dir, { keep, maxAgeDays, now = Date.now() } = {}) {
  if (!dir) return { removed: [], kept: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return { removed: [], kept: 0 }; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await stat(file);
      files.push({ file, name: entry.name, at: info.mtimeMs });
    } catch { /* vanished while listing */ }
  }
  files.sort((a, b) => b.at - a.at);
  const cutoff = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? now - maxAgeDays * DAY : undefined;
  const removed = [];
  for (const [index, item] of files.entries()) {
    const tooMany = Number.isFinite(keep) && keep >= 0 && index >= keep;
    const tooOld = cutoff !== undefined && item.at < cutoff;
    if (!tooMany && !tooOld) continue;
    try { await rm(item.file, { force: true }); removed.push(item.name); }
    catch { /* keep going: the next run will try again */ }
  }
  return { removed, kept: files.length - removed.length };
}
