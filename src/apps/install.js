import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { runProcess } from "./runtime.js";
import { findExecutable } from "./processes.js";

export function managedDirectory(home, id) { return path.join(home, "connectors", createHash("sha256").update(id).digest("hex").slice(0, 24)); }

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), headers: { "User-Agent": "dsh-doyourweb" } });
  if (!response.ok) throw new Error(`Package metadata HTTP ${response.status}`);
  const text = await response.text(); if (text.length > 3e6) throw new Error("Package metadata too large"); return JSON.parse(text);
}

export async function preparePackage(candidate, signal) {
  if (!candidate.package) return candidate;
  const pkg = candidate.package;
  if (pkg.type === "npm") {
    const metadata = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, signal);
    if (metadata.name !== pkg.name || metadata.version !== pkg.version) throw new Error("Registry package identity changed");
    const bins = typeof metadata.bin === "string" ? { [pkg.name.split("/").at(-1)]: metadata.bin } : metadata.bin || {};
    const entry = pkg.entry || (Object.keys(bins).length === 1 ? Object.keys(bins)[0] : undefined);
    if (!entry || !Object.hasOwn(bins, entry) || !/^[\w.-]+$/.test(entry)) throw new Error("Package exposes no unambiguous executable; configure package.entry in the connector");
    if (!/^sha(?:256|384|512)-/.test(metadata.dist?.integrity || "")) throw new Error("Package has no supported integrity digest; review and configure a local installation instead");
    return { ...candidate, package: { ...pkg, entry }, integrity: metadata.dist?.integrity, install: { type: "npm", package: `${pkg.name}@${pkg.version}`, scripts: false } };
  }
  if (pkg.type === "pypi") return { ...candidate, install: { type: "pypi", package: `${pkg.name}==${pkg.version}` } };
  throw new Error("Package registry type is not supported; add an explicit installed command");
}

export function desktopCandidate() {
  return { id: "cua-driver", label: "Cua Driver (DSH computer-use upstream)", kind: "desktop", provenance: "official", publisher: "github.com/trycua/cua",
    version: "0.28.0", command: "cua-driver", args: ["mcp"], docs: "https://github.com/trycua/cua/tree/cua-driver-rs-v0.28.0/libs/cua-driver",
    install: { type: "cua-release", tag: "cua-driver-rs-v0.28.0" } };
}

export async function installConnector(candidate, home, signal) {
  const directory = managedDirectory(home, candidate.id);
  await mkdir(directory, { recursive: true });
  const install = candidate.install;
  if (install?.type === "npm") {
    const npm = await findExecutable(process.platform === "win32" ? "npm.cmd" : "npm"); if (!npm) throw new Error("Install Node.js/npm first; no npm executable was found");
    const result = await runProcess(npm, ["install", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", install.package], { env: { NPM_CONFIG_CACHE: path.join(directory, "cache") }, signal, timeout: 180000 });
    if (result.exitCode !== 0) throw new Error(`npm install failed: ${result.stderr}`);
    const manifest = JSON.parse(await readFile(path.join(directory, "node_modules", ...candidate.package.name.split("/"), "package.json"), "utf8"));
    if (manifest.version !== candidate.package.version) throw new Error("Installed package version differs from reviewed version");
    const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));
    if (lock.packages?.[`node_modules/${candidate.package.name}`]?.integrity !== candidate.integrity) throw new Error("Installed package integrity differs from the reviewed package; refusing to execute");
    return { ...candidate, command: path.join(directory, "node_modules", ".bin", candidate.package.entry + (process.platform === "win32" ? ".cmd" : "")), installed: true };
  }
  if (install?.type === "pypi") {
    const uv = await findExecutable("uv"); if (!uv) throw new Error("Install uv first, or configure this Python MCP with an existing command");
    const bin = path.join(directory, "bin");
    const result = await runProcess(uv, ["tool", "install", install.package], { env: { UV_TOOL_DIR: path.join(directory, "tools"), UV_TOOL_BIN_DIR: bin, UV_CACHE_DIR: path.join(directory, "cache") }, signal, timeout: 180000 });
    if (result.exitCode !== 0) throw new Error(`Python tool install failed: ${result.stderr}`);
    const files = (await readdir(bin)).filter(name => process.platform !== "win32" || name.endsWith(".exe"));
    const entry = candidate.package.entry || (files.length === 1 ? files[0] : undefined);
    if (!entry || path.basename(entry) !== entry || !files.includes(entry)) throw new Error("Installed Python package has multiple entry points; choose package.entry in management");
    return { ...candidate, command: path.join(bin, entry), installed: true };
  }
  if (install?.type === "winget") {
    if (process.platform !== "win32" || !/^[A-Za-z0-9._-]+$/.test(install.package)) throw new Error("This installer requires Windows winget");
    const winget = await findExecutable("winget"); if (!winget) throw new Error("Windows App Installer/winget is not installed");
    const result = await runProcess(winget, ["install", "--id", install.package, "--exact", "--source", "winget", "--disable-interactivity"], { signal, timeout: 180000 });
    if (result.exitCode !== 0) throw new Error(`winget could not finish. Review any license or OS confirmation in Windows, then retry: ${result.stdout} ${result.stderr}`);
    const command = await findExecutable(candidate.command); if (!command) throw new Error("Installed, but the command is not yet in the DSH process PATH; restart DSH or set its absolute path");
    return { ...candidate, command, installed: true };
  }
  if (install?.type === "cua-release") {
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const release = await fetchJson(`https://api.github.com/repos/trycua/cua/releases/tags/${encodeURIComponent(install.tag)}`, signal);
    const name = `cua-driver-rs-${candidate.version}-${platform}-${arch}${platform === "windows" ? "-binary.zip" : ".tar.gz"}`;
    const asset = release.assets?.find(item => item.name === name);
    if (!asset?.digest?.startsWith("sha256:") || !asset.browser_download_url.startsWith("https://github.com/trycua/cua/releases/download/")) throw new Error("No verified Cua Driver binary is available for this OS/architecture");
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) }); if (!response.ok) throw new Error(`Driver download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 150e6 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) throw new Error("Driver download checksum mismatch or oversized archive");
    const archive = path.join(directory, name); await writeFile(archive, bytes, { mode: 0o600 });
    const unpack = path.join(directory, `binary-${randomUUID()}`); await mkdir(unpack, { recursive: true });
    if (platform === "windows") {
      const payload = Buffer.from(JSON.stringify({ archive, unpack }), "utf8").toString("base64");
      const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;[IO.Compression.ZipFile]::ExtractToDirectory($p.archive,$p.unpack)`;
      const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { signal, timeout: 30000 });
      if (result.exitCode !== 0) throw new Error(`Driver archive extraction failed: ${result.stderr}`);
    } else {
      const listing = await runProcess("tar", ["-tzf", archive], { signal });
      if (listing.exitCode !== 0 || listing.stdout.split("\n").some(name => name.startsWith("/") || name.split("/").includes(".."))) throw new Error("Unsafe driver archive paths");
      const result = await runProcess("tar", ["-xzf", archive, "-C", unpack], { signal }); if (result.exitCode !== 0) throw new Error("Driver extraction failed");
    }
    async function locate(dir, depth = 0) {
      if (depth > 3) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.name === (process.platform === "win32" ? "cua-driver.exe" : "cua-driver") && (await stat(file)).isFile()) return file;
        if (entry.isDirectory()) { const found = await locate(file, depth + 1); if (found) return found; }
      }
    }
    const command = await locate(unpack); if (!command) throw new Error("Downloaded archive does not contain cua-driver");
    return { ...candidate, command, installed: true };
  }
  throw new Error("No automatic installer is available; configure an installed executable or remote MCP URL");
}
