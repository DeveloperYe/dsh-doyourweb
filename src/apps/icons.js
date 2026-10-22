import { runFile } from "./processes.js";

const windowsIcons = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Drawing
$files=ConvertFrom-Json ([Console]::In.ReadToEnd())
$result=@{}
foreach ($file in $files) {
    $icon=$null; $bitmap=$null; $graphics=$null; $stream=$null
    try {
        $icon=[Drawing.Icon]::ExtractAssociatedIcon($file)
        if (-not $icon) { continue }
        $bitmap=[Drawing.Bitmap]::new(32,32)
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        $graphics.DrawIcon($icon,[Drawing.Rectangle]::new(0,0,32,32))
        $stream=[IO.MemoryStream]::new()
        $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
        $result[$file]='data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray())
    } catch { } finally {
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
        if ($icon) { $icon.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}
ConvertTo-Json -InputObject $result -Compress`;

export async function readWindowsIcons(files, signal) {
  if (process.platform !== "win32" || !files.length) return {};
  const request = runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(windowsIcons, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, signal });
  request.child.stdin.on("error", () => {}); // Startup failures are reported by execFile.
  request.child.stdin.end(JSON.stringify(files));
  const { stdout } = await request;
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}

export class AppIcons {
  constructor({ read = readWindowsIcons } = {}) { this.read = read; this.cache = new Map(); }
  async decorate(apps, signal) {
    signal?.throwIfAborted();
    const files = [...new Map(apps.filter(app => /^[a-z]:\\.+\.exe$/i.test(app.path || ""))
      .map(app => [app.path.toLowerCase(), app.path])).values()];
    const missing = files.filter(file => !this.cache.has(file.toLowerCase()));
    if (missing.length) {
      // Menu queries share the read; cancelling one query must not poison the cache for another.
      const request = Promise.resolve().then(() => this.read(missing));
      for (const file of missing) {
        const key = file.toLowerCase();
        this.cache.set(key, request.then(result => {
          const icon = result?.[file];
          return typeof icon === "string" && icon.length <= 12000 && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(icon) ? icon : undefined;
        }, () => undefined));
      }
    }
    const result = await Promise.all(apps.map(async app => ({ ...app, icon: await this.cache.get(app.path?.toLowerCase()) })));
    while (this.cache.size > 150) this.cache.delete(this.cache.keys().next().value);
    signal?.throwIfAborted();
    return result;
  }
}
