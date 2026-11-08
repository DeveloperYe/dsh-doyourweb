#!/usr/bin/env node
/**
 * Guard the one contract the client code calls by bare property access and that
 * `npm test` cannot see: DSH's composer facade (`conversation.input.shell(id)`).
 *
 * 0.8.3 shipped `shell.actions.persistDraft()` — a method DSH 0.2.0-rc.2 simply
 * does not have. Because the call ran *after* the reference chip was already
 * inserted, the throw left the draft unacknowledged and the one-second poll
 * re-inserted the same annotation ~20 times (one click, twenty chips). The unit
 * tests and `verify:dsh` both passed, because both stubbed `persistDraft`.
 *
 * So: read every `shell.<member>` / `shell.actions.<member>` the package calls,
 * then check each name against the *installed* DSH typings. The typings ship with
 * the npm package, so no app.asar is needed.
 *
 * Usage: node scripts/verify-input-actions.mjs [--dsh <dsh package dir>]
 * Exit codes: 0 verified, 1 a called member is missing, 2 DSH not found (skip).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

/** Directories whose sources call into the composer facade. */
const SOURCE_DIRS = ["src"];

/** Locate the installed @deepseek-ai/dsh package. */
async function findDsh() {
  const explicit = argument("--dsh") ?? process.env.DSH_PACKAGE_DIR;
  if (explicit) return path.resolve(explicit);
  const require = createRequire(path.join(root, "package.json"));
  const candidates = [];
  for (const name of ["@deepseek-ai/dsh", "@deepseek-ai/dsh/package.json"]) {
    try { candidates.push(require.resolve(name)); } catch { /* not resolvable from here */ }
  }
  // Global installs (npm/pnpm) are not visible from this package: walk PATH for a bin dir
  // that carries @deepseek-ai/dsh, plus the usual Windows npm roots.
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (entry) candidates.push(path.join(entry, "node_modules", "@deepseek-ai", "dsh"));
  }
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"));
  for (const candidate of candidates) {
    const dir = candidate.endsWith("package.json") ? path.dirname(candidate) : candidate;
    try {
      const packageJson = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      if (packageJson.name === "@deepseek-ai/dsh" && packageJson.version) return dir;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

/** `shell.state` / `shell.projection` / `shell.insertReference` live on the shell class. */
const SHELL_TYPINGS = [
  path.join("node_modules", "@deepseek-ai", "dsh-client-ui-conversation", "lib", "types", "client", "input", "facade.d.ts"),
];
/** `shell.actions.*` members live in the InputActions interface. */
const ACTIONS_TYPINGS = [
  path.join("node_modules", "@deepseek-ai", "dsh-client-ui-conversation", "lib", "types", "client", "contract", "input.d.ts"),
];

async function collect(dir, extension = ".js") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(full, extension));
    else if (entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

/**
 * Members of one `export interface Name {` / `export declare class Name {` block.
 * TypeScript modifiers are stripped, and `private` members count: the class is a real
 * object at runtime, so `shell.projection` (declared `private get`) is callable.
 */
function members(source, pattern) {
  const names = new Set();
  for (const block of source.matchAll(pattern)) {
    const body = block[1];
    for (const member of body.matchAll(/^\s{4}(?:(?:private|protected|public|static|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[(:<]/gm)) names.add(member[1]);
  }
  return names;
}

const dsh = await findDsh();
if (!dsh) {
  console.error("verify-input-actions: @deepseek-ai/dsh is not resolvable from this package; pass --dsh <dir>.");
  process.exit(2);
}

const load = async candidates => {
  for (const candidate of candidates) {
    const file = path.join(dsh, candidate);
    try { return await readFile(file, "utf8"); } catch { /* next shape */ }
  }
  throw new Error(`typings not found under ${dsh} (${candidates.join(", ")})`);
};

const shellSource = await load(SHELL_TYPINGS);
const actionsSource = await load(ACTIONS_TYPINGS);
const shellClass = members(shellSource, /export declare class SessionInputShell implements SessionInput \{([\s\S]*?)\n\}/g);
const actionsInterface = members(actionsSource, /export interface InputActions \{([\s\S]*?)\n\}/g);
if (!shellClass.size || !actionsInterface.size) throw new Error("could not parse the DSH composer typings");

/** Every facade member the package touches, with the sites that touch it. */
const used = new Map();
const record = (member, kind, file, line) => {
  const key = `${kind}:${member}`;
  if (!used.has(key)) used.set(key, []);
  used.get(key).push(`${path.relative(root, file)}:${line}`);
};
for (const dir of SOURCE_DIRS) {
  for (const file of await collect(path.join(root, dir))) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      for (const hit of text.matchAll(/\bshell\.actions\.([A-Za-z_$][\w$]*)/g)) record(hit[1], "actions", file, index + 1);
      // `shell.projection` / `shell.state` / `shell.insertReference` — but not `shell.actions`.
      // Uppercase members are COM objects (`WScript.Shell` → `shell.CreateShortcut`), not DSH.
      for (const hit of text.matchAll(/\bshell\.(?!actions\b)([a-z_$][\w$]*)/g)) record(hit[1], "shell", file, index + 1);
    });
  }
}

const missing = [];
for (const [key, sites] of used) {
  const [kind, member] = key.split(":");
  const known = kind === "actions" ? actionsInterface : shellClass;
  if (!known.has(member)) missing.push(`${kind}.${member} (${[...new Set(sites)].slice(0, 4).join(", ")})`);
}

if (missing.length) {
  console.error(`verify-input-actions: DSH ${dsh} does not provide:`);
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}
const version = JSON.parse(await readFile(path.join(dsh, "package.json"), "utf8")).version;
console.log(`PASS: ${used.size} composer members used by src/ all exist in @deepseek-ai/dsh ${version}.`);
console.log(`  actions: ${[...used.keys()].filter(key => key.startsWith("actions:")).map(key => key.slice(8)).join(", ")}`);
console.log(`  shell:   ${[...used.keys()].filter(key => key.startsWith("shell:")).map(key => key.slice(6)).join(", ")}`);
