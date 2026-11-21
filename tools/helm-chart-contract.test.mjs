// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { PROMETHEUS_METRIC_NAMES } from "../packages/kernel/src/domain/prometheus-metrics.ts";
import { readDaemonRegistry } from "../packages/kernel/src/daemon/registry.ts";
import { readFleetCenterConfig } from "../packages/daemon/src/daemon-host/fleet-center-config.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const chartRoot = path.join(repoRoot, "deploy/helm/harness-center");
const templatesRoot = path.join(chartRoot, "templates");

const REQUIRED_TEMPLATES = [
  "_helpers.tpl",
  "configmap.yaml",
  "deployment.yaml",
  "entrypoint-configmap.yaml",
  "networkpolicy.yaml",
  "NOTES.txt",
  "pdb.yaml",
  "prometheusrule.yaml",
  "pvc.yaml",
  "service.yaml",
  "serviceaccount.yaml",
  "servicemonitor.yaml",
  "statefulset.yaml",
];

function assertBalancedHelmDirectives(filePath, content) {
  let depth = 0;
  const actions = content.match(/\{\{[\s\S]*?\}\}/gu) ?? [];
  for (const action of actions) {
    const inner = action
      .replace(/^\{\{-?\s*/u, "")
      .replace(/\s*-?\}\}$/u, "")
      .trim();
    if (inner.startsWith("/*") || inner.startsWith("$")) continue;
    if (/^(?:if|with|range|define|block)\b/u.test(inner)) {
      depth += 1;
    } else if (/^end\b/u.test(inner)) {
      depth -= 1;
      assert.ok(depth >= 0, `${filePath}: unexpected {{ end }} (negative nesting depth)`);
    }
  }
  assert.equal(depth, 0, `${filePath}: unbalanced Helm template directives (remaining depth=${depth})`);
}

function validatePrometheusRuleSemantics(prometheusRuleTemplate) {
  const issues = [];
  const downBlock = /-\s*alert:\s*HarnessDaemonDown[\s\S]*?(?=\n\s*-\s*alert:|\n\{\{-?\s*end\b|$)/u.exec(
    prometheusRuleTemplate,
  )?.[0];
  if (!downBlock) {
    issues.push("Missing HarnessDaemonDown alert rule.");
  } else {
    if (/\bha_daemon_up\s*==\s*0\b/u.test(downBlock)) {
      issues.push("HarnessDaemonDown must not rely on ha_daemon_up == 0 (sample vanishes when target is down).");
    }
    if (
      !/\bup(?:\{[^}]*\})?\s*==\s*0\b/u.test(downBlock) &&
      !/\babsent\(\s*ha_daemon_up\b[^)]*\)\s*==\s*1\b/u.test(downBlock)
    ) {
      issues.push("HarnessDaemonDown must alert on scrape target up == 0 or absent(ha_daemon_up) == 1.");
    }
  }

  const rpcErrorBlock = /-\s*alert:\s*HarnessRpcErrorRateHigh[\s\S]*?(?=\n\s*-\s*alert:|\n\{\{-?\s*end\b|$)/u.exec(
    prometheusRuleTemplate,
  )?.[0];
  if (!rpcErrorBlock) {
    issues.push("Missing HarnessRpcErrorRateHigh alert rule.");
  } else {
    const numeratorAggregated =
      /\bsum\s*\(\s*rate\(\s*ha_daemon_rpc_requests_total\{outcome="error"\}\[5m\]\s*\)\s*\)/u.test(rpcErrorBlock);
    const denominatorAggregated = /\bsum\s*\(\s*rate\(\s*ha_daemon_rpc_requests_total\[5m\]\s*\)\s*\)/u.test(
      rpcErrorBlock,
    );
    const usesIgnoringOutcome = /\bignoring\s*\(\s*outcome\s*\)/u.test(rpcErrorBlock);
    if (!((numeratorAggregated && denominatorAggregated) || usesIgnoringOutcome)) {
      issues.push(
        'HarnessRpcErrorRateHigh must aggregate both numerator and denominator across outcomes (e.g. sum(rate(...{outcome="error"}[5m])) / clamp_min(sum(rate(...[5m])), 1e-9)) to avoid exact-label self-division to 1.',
      );
    }
  }
  return issues;
}

function extractEntrypointScript() {
  const template = readFileSync(path.join(templatesRoot, "entrypoint-configmap.yaml"), "utf8");
  const marker = "  start-center.sh: |\n";
  const index = template.indexOf(marker);
  assert.ok(index >= 0, "entrypoint-configmap.yaml must define data.start-center.sh");
  const scriptLines = template
    .slice(index + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("    ") ? line.slice(4) : line));
  return `${scriptLines.join("\n").trimEnd()}\n`;
}

test("Chart.yaml declares a valid Helm v2 generic application chart", () => {
  const chartPath = path.join(chartRoot, "Chart.yaml");
  assert.ok(existsSync(chartPath), "Chart.yaml must exist");
  const chart = parseYaml(readFileSync(chartPath, "utf8"));
  assert.equal(chart.apiVersion, "v2");
  assert.equal(chart.name, "harness-center");
  assert.equal(chart.type, "application");
  assert.match(String(chart.version), /^\d+\.\d+\.\d+/u);
  assert.match(String(chart.appVersion), /^\d+\.\d+\.\d+/u);
  assert.ok(typeof chart.description === "string" && chart.description.length > 10);
});

test("values.yaml validates strictly against values.schema.json and enforces secure generic defaults", () => {
  const valuesPath = path.join(chartRoot, "values.yaml");
  const schemaPath = path.join(chartRoot, "values.schema.json");
  assert.ok(existsSync(valuesPath), "values.yaml must exist");
  assert.ok(existsSync(schemaPath), "values.schema.json must exist");

  const values = parseYaml(readFileSync(valuesPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(values);
  assert.equal(valid, true, `values.yaml schema errors: ${JSON.stringify(validate.errors)}`);

  assert.equal(values.workloadKind, "Deployment");
  assert.equal(values.storage.backend, "postgres");
  assert.equal(values.identity.mode, "external");
  assert.equal(values.metrics.enabled, true);
  assert.equal(values.metrics.path, "/metrics");
  assert.equal(values.daemon.entrypoint, "/opt/ha/current/packages/daemon/dist/index.js");
  assert.equal(values.daemon.cliEntrypoint, "/opt/ha/current/packages/cli/dist/cli/src/index.js");
  assert.equal(values.podSecurityContext.runAsNonRoot, true);
  assert.equal(values.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(values.securityContext.capabilities.drop, ["ALL"]);
});

test("Helm templates provide stateless/stateful separation, probes, secrets separation, balanced syntax, and valid PromQL semantics", () => {
  for (const name of REQUIRED_TEMPLATES) {
    const filePath = path.join(templatesRoot, name);
    assert.ok(existsSync(filePath), `missing required template: ${name}`);
    const content = readFileSync(filePath, "utf8");
    assertBalancedHelmDirectives(name, content);
  }

  const deployment = readFileSync(path.join(templatesRoot, "deployment.yaml"), "utf8");
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  const configmap = readFileSync(path.join(templatesRoot, "configmap.yaml"), "utf8");
  const service = readFileSync(path.join(templatesRoot, "service.yaml"), "utf8");
  const serviceMonitor = readFileSync(path.join(templatesRoot, "servicemonitor.yaml"), "utf8");
  const prometheusRule = readFileSync(path.join(templatesRoot, "prometheusrule.yaml"), "utf8");

  // Stateless vs Stateful separation
  assert.ok(deployment.includes('eq .Values.workloadKind "Deployment"'));
  assert.ok(deployment.includes("kind: Deployment"));
  assert.ok(statefulset.includes('eq .Values.workloadKind "StatefulSet"'));
  assert.ok(statefulset.includes("kind: StatefulSet"));
  assert.ok(statefulset.includes("volumeClaimTemplates:"));

  // Both workloads wire entrypoint script, ConfigMap envFrom, probes, and Secret mounts
  assert.ok(configmap.includes("HARNESS_DAEMON_METRICS_PORT"));
  for (const [label, body] of [
    ["deployment.yaml", deployment],
    ["statefulset.yaml", statefulset],
  ]) {
    assert.ok(body.includes("/etc/harness/entrypoint/start-center.sh"), `${label} must invoke start-center.sh`);
    assert.ok(body.includes("configMapRef:"), `${label} must wire envFrom configMapRef`);
    assert.ok(body.includes("/healthz"), `${label} must probe /healthz`);
    assert.ok(body.includes("/readyz"), `${label} must probe /readyz`);
    assert.ok(body.includes("daemon-storage.json"), `${label} must mount PostgreSQL daemon-storage.json Secret`);
    assert.ok(body.includes("NODE_EXTRA_CA_CERTS"), `${label} must support optional enterprise CA bundle`);
  }

  // Service & Prometheus Operator integration
  assert.ok(service.includes("prometheus.io/scrape"));
  assert.ok(service.includes("fleet-tls"));
  assert.ok(service.includes("metrics"));
  assert.ok(serviceMonitor.includes("kind: ServiceMonitor"));
  assert.ok(prometheusRule.includes("kind: PrometheusRule"));

  // SSoT check: every ha_daemon_* metric referenced in PrometheusRule must exist in kernel PROMETHEUS_METRIC_NAMES
  const knownMetrics = new Set(Object.values(PROMETHEUS_METRIC_NAMES));
  const referenced = [...prometheusRule.matchAll(/\b(ha_daemon_[a-z0-9_]+)\b/gu)].map((match) => match[1]);
  assert.ok(referenced.length >= 4, "PrometheusRule must alert on core ha_daemon_* metrics");
  for (const metric of referenced) {
    assert.ok(
      knownMetrics.has(metric) || knownMetrics.has(metric.replace(/_(?:bucket|sum|count)$/u, "")),
      `PrometheusRule references unknown metric: ${metric}`,
    );
  }

  // PromQL semantic check (positive + negative regression fixtures for F-G7-01)
  assert.deepEqual(validatePrometheusRuleSemantics(prometheusRule), []);

  const brokenDownRule = `
        - alert: HarnessDaemonDown
          expr: ha_daemon_up == 0
        - alert: HarnessRpcErrorRateHigh
          expr: |
            (
              rate(ha_daemon_rpc_requests_total{outcome="error"}[5m])
              / clamp_min(rate(ha_daemon_rpc_requests_total[5m]), 1e-9)
            ) > 0.05
  `;
  const negativeIssues = validatePrometheusRuleSemantics(brokenDownRule);
  assert.ok(
    negativeIssues.some((issue) => issue.includes("HarnessDaemonDown")),
    `negative fixture must catch broken HarnessDaemonDown alert, got: ${negativeIssues}`,
  );
  assert.ok(
    negativeIssues.some((issue) => issue.includes("HarnessRpcErrorRateHigh")),
    `negative fixture must catch broken HarnessRpcErrorRateHigh alert, got: ${negativeIssues}`,
  );
});

test("every env var and secret mount emitted by the Helm chart has a real consumer and start-center.sh wires OIDC + Fleet end-to-end", () => {
  const configmap = readFileSync(path.join(templatesRoot, "configmap.yaml"), "utf8");
  const deployment = readFileSync(path.join(templatesRoot, "deployment.yaml"), "utf8");
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  const entrypointScript = extractEntrypointScript();

  const daemonConsumers = [
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/metrics-http-server.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/runtime-relay-target.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/daemon-host-open.ts"), "utf8"),
  ].join("\n");

  // Every env key emitted in configmap.yaml or workload env blocks must be consumed by daemon, Node, or start-center.sh
  const emittedEnvKeys = new Set([
    ...[...configmap.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gmu)].map((match) => match[1]),
    ...[...deployment.matchAll(/-\s*name:\s*([A-Z][A-Z0-9_]+)/gu)].map((match) => match[1]),
    ...[...statefulset.matchAll(/-\s*name:\s*([A-Z][A-Z0-9_]+)/gu)].map((match) => match[1]),
  ]);
  const nodeBuiltinEnvs = new Set(["NODE_EXTRA_CA_CERTS"]);
  assert.ok(emittedEnvKeys.size >= 10, "expected chart env keys to be checked");
  for (const key of emittedEnvKeys) {
    const consumed = nodeBuiltinEnvs.has(key) || daemonConsumers.includes(key) || entrypointScript.includes(key);
    assert.ok(consumed, `Helm chart emits unconsumed environment variable: ${key}`);
  }

  // Every volume mount path must be consumed by daemon, Node, or entrypoint config/script
  assert.ok(configmap.includes("/etc/harness/oidc/"));
  assert.ok(configmap.includes("/etc/harness/fleet-tls/"));
  assert.ok(entrypointScript.includes("HARNESS_OIDC_CLIENT_SECRET_FILE"));
  assert.ok(entrypointScript.includes("HARNESS_FLEET_TLS_CERT_FILE"));
  assert.ok(entrypointScript.includes("HARNESS_FLEET_TLS_KEY_FILE"));

  // Execute the real extracted start-center.sh against temp files and verify with real daemon/kernel parsers
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-helm-entrypoint-"));
  try {
    const scriptPath = path.join(sandbox, "start-center.sh");
    const userRoot = path.join(sandbox, "user");
    const repoRootDir = path.join(sandbox, "repos", "center");
    const oidcDir = path.join(sandbox, "oidc");
    const tlsDir = path.join(sandbox, "fleet-tls");
    const daemonLog = path.join(sandbox, "daemon-calls.jsonl");
    const cliLog = path.join(sandbox, "cli-calls.jsonl");
    mkdirSync(oidcDir, { recursive: true });
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(scriptPath, entrypointScript, { mode: 0o755 });
    writeFileSync(path.join(oidcDir, "client-secret"), "oidc-secret-value-42\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.crt"), "DUMMY-CERT\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.key"), "DUMMY-KEY\n", { mode: 0o600 });

    const stubDaemon = path.join(sandbox, "stub-daemon.cjs");
    const stubCli = path.join(sandbox, "stub-cli.cjs");
    writeFileSync(
      stubDaemon,
      `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(daemonLog)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const timer = setTimeout(() => process.exit(0), 250);
process.on("SIGTERM", () => { clearTimeout(timer); process.exit(0); });
`,
    );
    writeFileSync(
      stubCli,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const stdin = args.includes("--client-secret-stdin") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "bootstrap") {
  const rbacDir = path.join(process.env.HARNESS_DAEMON_USER_ROOT, "rbac");
  fs.mkdirSync(rbacDir, { recursive: true });
  fs.writeFileSync(path.join(rbacDir, "config.json"), JSON.stringify({ mode: "external" }) + "\\n");
}
`,
    );

    const sharedEnv = {
      ...process.env,
      HARNESS_DAEMON_ENTRY: stubDaemon,
      HARNESS_CLI_ENTRY: stubCli,
      HARNESS_DAEMON_ID: "center",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_OIDC_ISSUER_URL: "https://idp.example.org",
      HARNESS_OIDC_REALM: "fleet",
      HARNESS_OIDC_CLIENT_ID: "harness-center",
      HARNESS_OIDC_CLIENT_SECRET_FILE: path.join(oidcDir, "client-secret"),
      HARNESS_FLEET_BIND: "0.0.0.0",
      HARNESS_FLEET_PORT: "7545",
      HARNESS_FLEET_EXTERNAL_URL: "https://center.example.org:7545",
      HARNESS_FLEET_AUTHORITY_REPO_ID: "org-center",
      HARNESS_FLEET_AUTHORITY_REPO_ROOT: repoRootDir,
      HARNESS_FLEET_QUOTA_BYTES: "1073741824",
      HARNESS_FLEET_TLS_CERT_FILE: path.join(tlsDir, "tls.crt"),
      HARNESS_FLEET_TLS_KEY_FILE: path.join(tlsDir, "tls.key"),
      HARNESS_BOOTSTRAP_WAIT_ATTEMPTS: "5",
      HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "1",
    };

    // First boot: seeds daemon-registry/v2 + fleet-center-config/v1, starts daemon, runs ha bootstrap --mode external
    execFileSync("/bin/sh", [scriptPath], { env: sharedEnv, encoding: "utf8" });

    const registry = readDaemonRegistry({ userRoot });
    assert.equal(registry.invalidRepos.length, 0);
    assert.equal(registry.repos.length, 1);
    assert.equal(registry.repos[0]?.repoId, "org-center");
    assert.equal(registry.repos[0]?.canonicalRoot, path.resolve(repoRootDir));
    assert.equal(registry.repos[0]?.state, "enabled");

    const fleetConfig = readFleetCenterConfig(userRoot, "center");
    assert.ok(fleetConfig, "start-center.sh must seed a valid fleet-center-config/v1 file");
    assert.equal(fleetConfig.port, 7545);
    assert.equal(fleetConfig.bind, "0.0.0.0");
    assert.equal(fleetConfig.externalUrl, "https://center.example.org:7545");
    assert.equal(fleetConfig.repoId, "org-center");
    assert.equal(fleetConfig.certPath, path.resolve(path.join(tlsDir, "tls.crt")));
    assert.equal(fleetConfig.keyPath, path.resolve(path.join(tlsDir, "tls.key")));
    assert.equal(fleetConfig.quotaBytes, 1073741824);

    const cliCalls = readFileSync(cliLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bootstrapCall = cliCalls.find((call) => call.args[0] === "bootstrap");
    assert.ok(bootstrapCall, "start-center.sh must invoke ha bootstrap --mode external");
    assert.deepEqual(bootstrapCall.args, [
      "bootstrap",
      "--mode",
      "external",
      "--url",
      "https://idp.example.org",
      "--realm",
      "fleet",
      "--client-id",
      "harness-center",
      "--client-secret-stdin",
    ]);
    assert.equal(bootstrapCall.stdin, "oidc-secret-value-42\n");

    // Second boot: rbac/config.json already exists, so bootstrap is skipped (idempotent fast path)
    execFileSync("/bin/sh", [scriptPath], { env: sharedEnv, encoding: "utf8" });
    const cliCallsAfterRestart = readFileSync(cliLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      cliCallsAfterRestart.filter((call) => call.args[0] === "bootstrap").length,
      1,
      "subsequent restarts must not re-run external bootstrap when rbac/config.json already exists",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Helm chart contains zero customer-specific coupling, plaintext secrets, or local machine paths", () => {
  const allFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else allFiles.push(full);
    }
  };
  walk(chartRoot);

  const forbiddenPatterns = [
    /\/Users\//u,
    /\.harness-private/u,
    /\b(?:cmcc|chinamobile|mobilework|panwei|taas|lingxi|moma)\b/iu,
    /postgresql:\/\/[^:\s]+:[^@\s<>{}$]+@/u,
  ];

  for (const file of allFiles) {
    const content = readFileSync(file, "utf8");
    const rel = path.relative(repoRoot, file);
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(
        content,
        pattern,
        `${rel} must not contain customer coupling, plaintext password, or local path`,
      );
    }
  }
});
