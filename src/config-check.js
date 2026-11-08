/**
 * Startup sanity checks for the plugin config.
 *
 * The plugin takes its config without a schema, and several mistakes fail silently: a
 * publicUrl that does not parse is skipped, a remote deployment without TLS simply never
 * connects, and a budget below one tab's worth injects nothing. Every problem is reported
 * once at startup with a stable code so it can be grepped in the DSH log.
 *
 * Levels: "error" stops the plugin (the bridge would refuse this anyway, only with a later
 * and less specific message); "warn" is a misconfiguration the operator should fix.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const isLoopback = bind => {
  const value = String(bind || "127.0.0.1").trim().toLowerCase();
  return LOOPBACK.has(value);
};

const hostOf = entry => (/^(\[[^\]]+\]|[^:]+)/.exec(String(entry).trim())?.[1] || "").toLowerCase();

/** @returns {{ level: "error" | "warn", code: string, message: string }[]} */
export function checkConfig(config = {}) {
  const problems = [];
  const error = (code, message) => problems.push({ level: "error", code, message });
  const warn = (code, message) => problems.push({ level: "warn", code, message });

  const bind = config.bind || "127.0.0.1";
  const remote = config.remote === true;
  const tls = config.tls === true;
  const tlsPort = config.tlsPort ?? 8443;
  const extensionPort = config.extensionPort;
  const hosts = Array.isArray(config.hosts) ? config.hosts : [];

  // A non-loopback bind without `remote` is refused by the bridge; say so here, in words.
  if (!isLoopback(bind) && !remote) {
    error("remote-required", `bind 是 ${bind}（非回环）但没有开 remote: true；要对外提供请显式加 remote: true，否则改回 127.0.0.1`);
  }

  // Plain text on a public interface: the extension still works, but nothing is encrypted.
  if (!isLoopback(bind) && remote && !tls) {
    warn("plaintext-remote", `远程暴露但 tls: false：扩展会用 ws:// 明文连接，任何中间人都能读取页面内容；建议 tls: true`);
  }

  // Host allowlist entries must be bare hostnames: the port comes from port/tlsPort.
  for (const entry of hosts) {
    if (/:\d+$/.test(String(entry).trim()) && !/^\[.+\]:\d+$/.test(String(entry).trim())) {
      warn("hosts-with-port", `hosts 里的 "${entry}" 带了端口；白名单只比对主机名，端口请用 port / tlsPort / extensionPort 配置`);
    }
  }

  let publicHost;
  if (config.publicUrl) {
    const raw = String(config.publicUrl).trim();
    let parsed;
    try {
      parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      parsed = undefined;
    }
    if (!parsed || !parsed.hostname) {
      warn("public-url-invalid", `publicUrl "${raw}" 无法解析，已忽略；管理页会退回 http://127.0.0.1:${config.port ?? 43187}`);
    } else {
      publicHost = parsed.hostname.toLowerCase();
      if (parsed.protocol === "https:" && !tls) {
        warn("public-https-without-tls", `publicUrl 是 https，但 tls: false：扩展会按 wss 连接，而插件没有开 TLS 端点，必然连不上`);
      }
      if (parsed.port && extensionPort && String(parsed.port) !== String(extensionPort)) {
        warn("extension-port-mismatch", `publicUrl 的端口 ${parsed.port} 与 extensionPort ${extensionPort} 不一致；扩展会连 ${extensionPort}，请确认 NAT 映射指向 tlsPort ${tlsPort}`);
      }
      if (!parsed.port && extensionPort && String(extensionPort) !== "443") {
        warn("extension-port-mismatch", `publicUrl 没写端口（默认 443），但 extensionPort 是 ${extensionPort}；扩展会连 ${extensionPort}`);
      }
    }
  }

  // The public hostname has to pass the Host allowlist; deriveFromPublicUrl adds it for you.
  if (publicHost && !hosts.some(entry => hostOf(entry) === publicHost)) {
    warn("hosts-missing-public", `hosts 里没有 ${publicHost}；插件会自动补上，但请在配置里写清楚，免得下次换地址时以为是它漏了`);
  }

  // Injection budget: below one tab's worth nothing is injected, above the cap it is clamped.
  const budget = config.snapshotChars;
  if (budget !== undefined && budget !== null && budget !== "") {
    const size = Number(budget);
    if (!Number.isFinite(size) || size < 0) {
      warn("injection-budget-invalid", `snapshotChars "${budget}" 不是有效数字，按 0（只授权不预读）处理`);
    } else if (size > 0 && size < 400) {
      warn("injection-budget-too-small", `snapshotChars ${size} 装不下一条页面快照（至少 400），实际不会注入；用 0 明确关闭，或给 ≥400`);
    } else if (size > 8000) {
      warn("injection-budget-capped", `snapshotChars ${size} 超过上限，实际按 8000 处理`);
    }
  }

  // TLS port fallback silently moves the listener, which no NAT rule points at.
  if (tls && remote && config.tlsPort === undefined && config.tlsPortFallback !== false) {
    warn("tls-port-fallback", `没写 tlsPort：默认 ${tlsPort} 被占用时会自动换端口，而 NAT 映射仍指向 ${tlsPort}，扩展会连不上；远程部署请显式写 tlsPort 并设 tlsPortFallback: false`);
  }

  return problems;
}

/** One line per problem, ready for the DSH log. */
export function describeProblems(problems) {
  return problems.map(problem => `${problem.level === "error" ? "配置错误" : "配置提示"} [${problem.code}] ${problem.message}`);
}
