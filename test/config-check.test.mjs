import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConfig, describeProblems } from "../src/config-check.js";

const codes = config => checkConfig(config).map(problem => problem.code);
const has = (config, code) => codes(config).includes(code);

test("a same-machine install with no config reports nothing", () => {
  assert.deepEqual(checkConfig({}), []);
  assert.deepEqual(checkConfig({ port: 43187, snapshotChars: 0 }), []);
});

test("the shipped remote configuration is clean", () => {
  // Mirrors the live deployment: this is the shape the README recommends, so it must not
  // produce noise. A regression here means the warnings became nagging.
  const problems = checkConfig({
    port: 43287, bind: "0.0.0.0", remote: true, tls: true, tlsPort: 8443,
    extensionPort: 39066, publicUrl: "https://203.0.113.10:39066",
    hosts: ["203.0.113.10", "10.0.0.5"], tlsIps: ["203.0.113.10", "10.0.0.5"],
    extensionScheme: "wss", snapshotChars: 0,
  });
  assert.deepEqual(problems, []);
});

test("a public bind without remote is an error, not a silent refusal later", () => {
  const problems = checkConfig({ bind: "0.0.0.0" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "error");
  assert.equal(problems[0].code, "remote-required");
  assert.match(problems[0].message, /remote: true/);
});

test("remote without TLS is reported as plaintext exposure", () => {
  assert.equal(has({ bind: "0.0.0.0", remote: true }, "plaintext-remote"), true);
  assert.equal(has({ bind: "0.0.0.0", remote: true, tls: true }, "plaintext-remote"), false);
});

test("an unparseable publicUrl is called out instead of being skipped quietly", () => {
  assert.equal(has({ publicUrl: "https://" }, "public-url-invalid"), true);
  assert.equal(has({ publicUrl: "http://browser.example.test" }, "public-url-invalid"), false);
});

test("https in publicUrl without tls cannot work, and says so", () => {
  assert.equal(has({ publicUrl: "https://browser.example.test", hosts: ["browser.example.test"] }, "public-https-without-tls"), true);
  assert.equal(has({ publicUrl: "https://browser.example.test", tls: true, hosts: ["browser.example.test"] }, "public-https-without-tls"), false);
});

test("port mismatches between publicUrl and extensionPort are flagged", () => {
  assert.equal(has({ publicUrl: "https://h.test:9443", extensionPort: 39066, tls: true, hosts: ["h.test"] }, "extension-port-mismatch"), true);
  assert.equal(has({ publicUrl: "https://h.test:39066", extensionPort: 39066, tls: true, hosts: ["h.test"] }, "extension-port-mismatch"), false);
});

test("a public host missing from the allowlist is a hint, not a failure", () => {
  const problems = checkConfig({ publicUrl: "https://browser.example.test:39066", extensionPort: 39066, tls: true, hosts: ["10.0.0.5"] });
  const hint = problems.find(problem => problem.code === "hosts-missing-public");
  assert.ok(hint);
  assert.equal(hint.level, "warn");
});

test("hosts entries carrying a port are pointed out", () => {
  assert.equal(has({ hosts: ["browser.example.test:39066"] }, "hosts-with-port"), true);
  assert.equal(has({ hosts: ["browser.example.test"] }, "hosts-with-port"), false);
});

test("injection budgets that cannot hold one tab are explained", () => {
  assert.equal(has({ snapshotChars: 300 }, "injection-budget-too-small"), true);
  assert.equal(has({ snapshotChars: 9000 }, "injection-budget-capped"), true);
  assert.equal(has({ snapshotChars: "abc" }, "injection-budget-invalid"), true);
  // 400 is exactly one tab, so it is allowed even though it only fits one.
  assert.equal(has({ snapshotChars: 400 }, "injection-budget-too-small"), false);
  assert.equal(has({ snapshotChars: 0 }, "injection-budget-too-small"), false);
});

test("a remote deployment relying on the TLS port fallback is warned", () => {
  assert.equal(has({ bind: "0.0.0.0", remote: true, tls: true }, "tls-port-fallback"), true);
  assert.equal(has({ bind: "0.0.0.0", remote: true, tls: true, tlsPort: 8443 }, "tls-port-fallback"), false);
  assert.equal(has({ bind: "0.0.0.0", remote: true, tls: true, tlsPortFallback: false }, "tls-port-fallback"), false);
});

test("problems render as one log line each, with their code", () => {
  const lines = describeProblems(checkConfig({ bind: "0.0.0.0" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /配置错误 \[remote-required\]/);
});
