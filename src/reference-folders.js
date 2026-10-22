const groups = { folder: { prefix: "文件夹:", label: "文件夹", icon: "folder", aliases: ["文件夹", "folder", "folders"] }, file: { prefix: "文件:", label: "文件", icon: "file", aliases: ["文件", "file", "files"] }, session: { prefix: "对话:", label: "对话", icon: "session", aliases: ["对话", "session", "sessions"] } };
const toggleKind = "doyourweb-reference-group";

export function referenceQuery(query = "") {
  const normalized = query.toLowerCase();
  for (const [kind, group] of Object.entries(groups)) for (const alias of group.aliases) {
    if (normalized === alias) return { kind, query: "", ...group };
    if (normalized.startsWith(`${alias}:`) || normalized.startsWith(`${alias}：`)) return { kind, query: query.slice(alias.length + 1), ...group };
  }
}

function valueOf(candidate) {
  try { return JSON.parse(candidate.value); } catch { return {}; }
}
function kindOf(candidate) { const value = valueOf(candidate); return value.kind === "file" && value.fileKind === "directory" ? "folder" : value.kind; }

function toggle(kind, expanded, section, count) {
  const group = groups[kind];
  return { name: expanded ? `收起${group.label}` : count ? `展开${group.label}（${count}）` : `搜索${group.label}`, section, icon: group.icon,
    ...(!expanded && !count ? { description: "暂无文件候选，输入名称搜索或进入文件夹" } : {}), ...(!expanded ? { drill: true } : {}),
    value: JSON.stringify({ kind: toggleKind, text: expanded ? "@" : `@${group.prefix}` }) };
}

// DSH has no public result-filter hook. Decorate only its native reference source;
// retain the same owner, codecs and file navigation, and restore it on unload.
export function compactReferences(service, { preview = 3 } = {}) {
  if (!Array.isArray(service?.live?.sources)) return () => {};
  const originals = new Map();
  function decorate(source) {
    if (source.trigger !== "@" || source.name !== "reference" || originals.has(source)) return;
    const original = { candidates: source.candidates, onPick: source.onPick, header: source.header, order: source.order };
    if (typeof original.candidates !== "function" || typeof original.onPick !== "function") return;
    const wrapped = {
      order: Math.min(source.order ?? 0, -100),
      async candidates(session, request) {
        const category = !request.quoted && referenceQuery(request.query);
        const items = await original.candidates.call(source, session, category ? { ...request, query: category.query } : request);
        if (category) {
          const matches = items.filter(item => kindOf(item) === category.kind);
          return [toggle(category.kind, true, groups[category.kind].label, matches.length), ...matches];
        }
        if (request.query || request.quoted || request.drilled) return items;
        const sections = new Map();
        for (const item of items) {
          const kind = kindOf(item), section = ["file", "folder"].includes(kind) ? groups[kind].label : item.section;
          const key = `${kind}:${section || ""}`;
          if (!sections.has(key)) sections.set(key, { kind, section, items: [] });
          sections.get(key).items.push(["file", "folder"].includes(kind) ? { ...item, section, ...(kind === "folder" ? { drill: true } : {}) } : item);
        }
        if (![...sections.values()].some(section => section.kind === "file")) sections.set("file:文件", { kind: "file", section: "文件", items: [] });
        const order = { file: 0, folder: 1, session: 2 };
        return [...sections.values()].sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3)).flatMap(({ kind, section, items }) => !groups[kind] ? items
          : [...items.slice(0, preview), ...(items.length > preview || !items.length ? [toggle(kind, false, section, items.length)] : [])]);
      },
      onPick(request) {
        const value = valueOf(request.candidate);
        return value.kind === toggleKind ? { text: value.text, continue: true } : original.onPick.call(source, request);
      },
      header(session, request) {
        const category = !request.quoted && referenceQuery(request.query);
        if (!category) return original.header?.call(source, session, request);
        return [{ label: category.label, current: true, value: "" }];
      },
    };
    Object.assign(source, wrapped); originals.set(source, { original, wrapped });
  }
  service.live.sources.forEach(decorate);
  const descriptor = Object.getOwnPropertyDescriptor(service, "registerSource");
  const register = service.registerSource;
  const wrappedRegister = function (source) { decorate(source); return register.call(this, source); };
  Object.defineProperty(service, "registerSource", { configurable: true, writable: true, value: wrappedRegister });
  return () => {
    for (const [source, { original, wrapped }] of originals) for (const key of Object.keys(wrapped)) {
      if (source[key] !== wrapped[key]) continue;
      if (original[key] === undefined) delete source[key]; else source[key] = original[key];
    }
    if (Object.getOwnPropertyDescriptor(service, "registerSource")?.value === wrappedRegister) {
      if (descriptor) Object.defineProperty(service, "registerSource", descriptor); else delete service.registerSource;
    }
    originals.clear();
  };
}
