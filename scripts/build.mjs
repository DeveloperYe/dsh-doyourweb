import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("lib", { recursive: true });
await build({ entryPoints: ["src/host.js"], outfile: "lib/host.js", bundle: true,
  platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: true });
const client = await build({ entryPoints: ["src/client-entry.js"], bundle: true, write: false,
  platform: "browser", format: "cjs", target: "es2022",
  external: ["react", "@deepseek-ai/dsh-client-ui-primitives"] });
await writeFile("lib/client.js", `window.__ModuleLoader__.load({id:"dsh-browser-tabs",factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log("Built DSH host and client modules.");
