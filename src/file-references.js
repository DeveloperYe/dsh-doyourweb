import { readdir } from "node:fs/promises";

// The local DSH provider ranks directories first, then caps the whole result.
// Backfill a bounded file share only when that cap has excluded every file.
export function balanceFileReferences(service, workingDirectory) {
  const limit = service?.config?.maxResults;
  if (typeof service?.list !== "function" || typeof workingDirectory?.ensure !== "function"
    || !Number.isSafeInteger(limit) || limit < 2 || !Array.isArray(service.config.excludedDirectories)) return () => {};
  const descriptor = Object.getOwnPropertyDescriptor(service, "list"), original = service.list;
  const wrapped = async function (agent, query, signal) {
    const items = await original.call(this, agent, query, signal);
    if (query !== "" || items.length < limit || !items.every(item => item.kind === "directory")) return items;
    signal.throwIfAborted();
    try {
      const root = await workingDirectory.ensure(agent, signal);
      const entries = await readdir(root, { withFileTypes: true });
      signal.throwIfAborted();
      const files = entries.filter(entry => entry.isFile() && !entry.name.startsWith("."))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .slice(0, Math.floor(limit / 2)).map(entry => ({ path: entry.name, kind: "file" }));
      return files.length ? [...items.slice(0, limit - files.length), ...files] : items;
    } catch (error) { if (signal.aborted) throw error; return items; }
  };
  Object.defineProperty(service, "list", { configurable: true, writable: true, value: wrapped });
  return () => {
    if (Object.getOwnPropertyDescriptor(service, "list")?.value !== wrapped) return;
    if (descriptor) Object.defineProperty(service, "list", descriptor); else delete service.list;
  };
}
