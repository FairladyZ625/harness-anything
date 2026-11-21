// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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
  "service-headless.yaml",
  "service-metrics.yaml",
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

function renderPrometheusRuleForRelease(template, { namespace, metricsServiceName, rpcThreshold = 0.05 }) {
  return template
    .replace(/\{\{-\s*if[\s\S]*?\}\}\n?/u, "")
    .replace(/\{\{-\s*\$ns\s*:=[\s\S]*?\}\}\n?/u, "")
    .replace(/\{\{-\s*\$svc\s*:=[\s\S]*?\}\}\n?/u, "")
    .replace(/\{\{\s*\$ns\s*\}\}/gu, namespace)
    .replace(/\{\{\s*\$svc\s*\}\}/gu, metricsServiceName)
    .replace(/\{\{\s*\.Values\.metrics\.prometheusRule\.writeQueueDepthThreshold\s*\}\}/gu, "32")
    .replace(/\{\{\s*\.Values\.metrics\.prometheusRule\.projectionLagThreshold\s*\}\}/gu, "500")
    .replace(/\{\{\s*\.Values\.metrics\.prometheusRule\.rpcErrorRatioThreshold\s*\}\}/gu, String(rpcThreshold));
}

function validatePrometheusRuleSemantics(prometheusRuleText) {
  const issues = [];
  const downBlock = /-\s*alert:\s*HarnessDaemonDown[\s\S]*?(?=\n\s*-\s*alert:|\n\{\{-?\s*end\b|$)/u.exec(
    prometheusRuleText,
  )?.[0];
  if (!downBlock) {
    issues.push("Missing HarnessDaemonDown alert rule.");
  } else {
    if (/\bha_daemon_up\s*==\s*0\b/u.test(downBlock)) {
      issues.push("HarnessDaemonDown must not rely on ha_daemon_up == 0 (sample vanishes when target is down).");
    }
    if (/\babsent\(\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\)/u.test(downBlock)) {
      issues.push(
        "HarnessDaemonDown absent() must scope to release namespace and service labels (unscoped absent() is masked by other releases).",
      );
    }
    const scopedUpDown = /\bup\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*\}\s*==\s*0\b/u.test(downBlock);
    const scopedAbsent = /\babsent\(\s*up\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*\}\s*\)/u.test(downBlock);
    if (!scopedUpDown || !scopedAbsent) {
      issues.push(
        "HarnessDaemonDown must scope both up == 0 and absent(up{...}) to the release namespace and metrics service labels.",
      );
    }
  }

  const rpcErrorBlock = /-\s*alert:\s*HarnessRpcErrorRateHigh[\s\S]*?(?=\n\s*-\s*alert:|\n\{\{-?\s*end\b|$)/u.exec(
    prometheusRuleText,
  )?.[0];
  if (!rpcErrorBlock) {
    issues.push("Missing HarnessRpcErrorRateHigh alert rule.");
  } else {
    const numeratorScoped =
      /\bsum\s*\(\s*rate\(\s*ha_daemon_rpc_requests_total\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*outcome="error"[^}]*\}\[5m\]\s*\)\s*\)/u.test(
        rpcErrorBlock,
      );
    const denominatorScoped =
      /\bsum\s*\(\s*rate\(\s*ha_daemon_rpc_requests_total\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*\}\[5m\]\s*\)\s*\)/u.test(
        rpcErrorBlock,
      );
    if (!numeratorScoped || !denominatorScoped) {
      issues.push(
        "HarnessRpcErrorRateHigh must scope both numerator and denominator sum(rate(...)) to release namespace and metrics service labels.",
      );
    }
  }

  for (const alertName of ["HarnessWriteQueueSaturated", "HarnessProjectionLagHigh"]) {
    const block = new RegExp(
      `-\\s*alert:\\s*${alertName}[\\s\\S]*?(?=\\n\\s*-\\s*alert:|\\n\\{\\{-?\\s*end\\b|$)`,
      "u",
    ).exec(prometheusRuleText)?.[0];
    if (!block || !/\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*\}/u.test(block)) {
      issues.push(`${alertName} must scope its metric selector to release namespace and metrics service labels.`);
    }
  }
  return issues;
}

function evaluateScopedAlerts(renderedRule, samples) {
  const downExpr = /-\s*alert:\s*HarnessDaemonDown[\s\S]*?expr:\s*(.+)/u.exec(renderedRule)?.[1]?.trim() ?? "";
  const downSelector = /up\{namespace="([^"]+)",service="([^"]+)"\}/u.exec(downExpr);
  assert.ok(downSelector, `expected scoped up selector in HarnessDaemonDown: ${downExpr}`);
  const [, ns, svc] = downSelector;
  const matchingUp = samples.up.filter((s) => s.namespace === ns && s.service === svc);
  const downFires = matchingUp.length === 0 || matchingUp.some((s) => s.value === 0);

  const rpcBlock =
    /-\s*alert:\s*HarnessRpcErrorRateHigh[\s\S]*?expr:\s*\|([\s\S]*?)\n\s+for:/u.exec(renderedRule)?.[1] ?? "";
  const rpcThreshold = Number(/>\s*([0-9.]+)/u.exec(rpcBlock)?.[1] ?? "NaN");
  const numSel = /ha_daemon_rpc_requests_total\{namespace="([^"]+)",service="([^"]+)",outcome="error"\}/u.exec(
    rpcBlock,
  );
  const denSel = /clamp_min\(sum\(rate\(ha_daemon_rpc_requests_total\{namespace="([^"]+)",service="([^"]+)"\}/u.exec(
    rpcBlock,
  );
  assert.ok(numSel && denSel, `expected scoped RPC selectors in HarnessRpcErrorRateHigh: ${rpcBlock}`);
  const errRate = samples.rpcRates
    .filter((s) => s.namespace === numSel[1] && s.service === numSel[2] && s.outcome === "error")
    .reduce((sum, s) => sum + s.rate, 0);
  const totalRate = samples.rpcRates
    .filter((s) => s.namespace === denSel[1] && s.service === denSel[2])
    .reduce((sum, s) => sum + s.rate, 0);
  const rpcErrorFires = errRate / Math.max(totalRate, 1e-9) > rpcThreshold;

  return { downFires, rpcErrorFires };
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

function waitForFile(filePath, timeoutMs = 10_000) {
  if (existsSync(filePath)) return Promise.resolve();
  const dir = path.dirname(filePath);
  const targetName = path.basename(filePath);
  return new Promise((resolve, reject) => {
    const watcher = watch(dir, (_eventType, filename) => {
      if ((filename === null || filename === targetName) && existsSync(filePath)) {
        clearTimeout(guard);
        watcher.close();
        resolve();
      }
    });
    const guard = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for file: ${filePath}`));
    }, timeoutMs);
    if (existsSync(filePath)) {
      clearTimeout(guard);
      watcher.close();
      resolve();
    }
  });
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

test("values.yaml validates strictly against values.schema.json and schema enforces single-writer, PG Secret, and non-probe metrics path", () => {
  const valuesPath = path.join(chartRoot, "values.yaml");
  const schemaPath = path.join(chartRoot, "values.schema.json");
  assert.ok(existsSync(valuesPath), "values.yaml must exist");
  assert.ok(existsSync(schemaPath), "values.schema.json must exist");

  const values = parseYaml(readFileSync(valuesPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(values), true, `values.yaml schema errors: ${JSON.stringify(validate.errors)}`);

  assert.equal(values.workloadKind, "Deployment");
  assert.equal(values.replicaCount, 1);
  assert.equal(values.storage.backend, "postgres");
  assert.ok(values.storage.existingSecret.length > 0, "default postgres storage must reference a Secret name");
  assert.equal(values.identity.mode, "external");
  assert.equal(values.metrics.enabled, true);
  assert.equal(values.metrics.path, "/metrics");
  assert.equal(values.daemon.entrypoint, "/opt/ha/current/packages/daemon/dist/index.js");
  assert.equal(values.daemon.cliEntrypoint, "/opt/ha/current/packages/cli/dist/cli/src/index.js");
  assert.equal(values.podSecurityContext.runAsNonRoot, true);
  assert.equal(values.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(values.securityContext.capabilities.drop, ["ALL"]);

  // F-G7-11: single-authority topology locks replicaCount === 1
  assert.equal(validate({ ...values, replicaCount: 2 }), false, "schema must reject replicaCount > 1");
  assert.equal(validate({ ...values, replicaCount: 0 }), false, "schema must reject replicaCount < 1");

  // F-G7-11: postgres backend requires non-empty existingSecret, while sqlite allows empty
  assert.equal(
    validate({ ...values, storage: { ...values.storage, backend: "postgres", existingSecret: "" } }),
    false,
    "schema must reject postgres backend without existingSecret",
  );
  assert.equal(
    validate({ ...values, storage: { ...values.storage, backend: "sqlite", existingSecret: "" } }),
    true,
    "schema must allow sqlite backend without existingSecret",
  );

  // F-G7-13: reject reserved probe paths and traversal variants in metrics.path
  for (const forbidden of ["/healthz", "/readyz", "/healthz/", "/readyz/", "//healthz", "/./readyz", "/a/../healthz"]) {
    assert.equal(
      validate({ ...values, metrics: { ...values.metrics, path: forbidden } }),
      false,
      `values.schema.json must reject metrics.path=${forbidden}`,
    );
  }
  for (const allowed of ["/metrics", "/custom/metrics", "/healthz-metrics"]) {
    assert.equal(
      validate({ ...values, metrics: { ...values.metrics, path: allowed } }),
      true,
      `values.schema.json must allow metrics.path=${allowed}`,
    );
  }
});

test("Helm templates isolate Fleet vs Metrics Services, wire StatefulSet headless Service, validate topology, and isolate multi-release PromQL alerts", () => {
  for (const name of REQUIRED_TEMPLATES) {
    const filePath = path.join(templatesRoot, name);
    assert.ok(existsSync(filePath), `missing required template: ${name}`);
    const content = readFileSync(filePath, "utf8");
    assertBalancedHelmDirectives(name, content);
  }

  const helpers = readFileSync(path.join(templatesRoot, "_helpers.tpl"), "utf8");
  const deployment = readFileSync(path.join(templatesRoot, "deployment.yaml"), "utf8");
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  const configmap = readFileSync(path.join(templatesRoot, "configmap.yaml"), "utf8");
  const fleetService = readFileSync(path.join(templatesRoot, "service.yaml"), "utf8");
  const metricsService = readFileSync(path.join(templatesRoot, "service-metrics.yaml"), "utf8");
  const headlessService = readFileSync(path.join(templatesRoot, "service-headless.yaml"), "utf8");
  const serviceMonitor = readFileSync(path.join(templatesRoot, "servicemonitor.yaml"), "utf8");
  const prometheusRule = readFileSync(path.join(templatesRoot, "prometheusrule.yaml"), "utf8");

  // F-G7-11: single-writer / PG / metrics path render-time validation + StatefulSet headless Service
  assert.ok(helpers.includes('define "harness-center.validateValues"'));
  assert.ok(helpers.includes("fail "));
  assert.ok(configmap.includes('include "harness-center.validateValues"'));
  assert.ok(configmap.includes(".Values.storage.backend"));
  assert.ok(deployment.includes('eq .Values.workloadKind "Deployment"'));
  assert.ok(statefulset.includes('eq .Values.workloadKind "StatefulSet"'));
  assert.ok(statefulset.includes('serviceName: {{ include "harness-center.headlessServiceName" . }}'));
  assert.ok(headlessService.includes('eq .Values.workloadKind "StatefulSet"'));
  assert.ok(headlessService.includes("clusterIP: None"));

  // F-G7-12: Fleet Service exposes ONLY fleet-tls; Metrics Service is ALWAYS ClusterIP and exposes ONLY metrics
  assert.ok(fleetService.includes("name: fleet-tls"));
  assert.ok(fleetService.includes("type: {{ .Values.service.type }}"));
  assert.ok(!fleetService.includes("name: metrics"), "Fleet Service must never co-expose metrics port");
  assert.ok(!fleetService.includes("prometheus.io/scrape"), "Fleet Service must not advertise Prometheus scraping");

  assert.ok(metricsService.includes("type: ClusterIP"), "Metrics Service must be strictly ClusterIP");
  assert.ok(!metricsService.includes(".Values.service.type"), "Metrics Service must ignore external service.type");
  assert.ok(metricsService.includes("name: metrics"));
  assert.ok(!metricsService.includes("name: fleet-tls"), "Metrics Service must not expose fleet-tls port");
  assert.ok(metricsService.includes("app.kubernetes.io/component: metrics"));
  assert.ok(metricsService.includes("prometheus.io/scrape"));
  assert.ok(serviceMonitor.includes("app.kubernetes.io/component: metrics"));

  // SSoT check: every ha_daemon_* metric referenced in PrometheusRule exists in PROMETHEUS_METRIC_NAMES
  const knownMetrics = new Set(Object.values(PROMETHEUS_METRIC_NAMES));
  const referenced = [...prometheusRule.matchAll(/\b(ha_daemon_[a-z0-9_]+)\b/gu)].map((match) => match[1]);
  assert.ok(referenced.length >= 3, "PrometheusRule must alert on core ha_daemon_* metrics");
  for (const metric of referenced) {
    assert.ok(
      knownMetrics.has(metric) || knownMetrics.has(metric.replace(/_(?:bucket|sum|count)$/u, "")),
      `PrometheusRule references unknown metric: ${metric}`,
    );
  }

  // F-G7-08: multi-release PromQL scoping (positive + multi-release simulation + negative fixtures)
  const alphaRule = renderPrometheusRuleForRelease(prometheusRule, {
    namespace: "prod",
    metricsServiceName: "alpha-harness-center-metrics",
  });
  const betaRule = renderPrometheusRuleForRelease(prometheusRule, {
    namespace: "prod",
    metricsServiceName: "beta-harness-center-metrics",
  });
  assert.deepEqual(validatePrometheusRuleSemantics(alphaRule), []);
  assert.deepEqual(validatePrometheusRuleSemantics(betaRule), []);

  // Case 1: alpha vanishes from service discovery while beta is healthy -> alpha fires, beta stays green
  const missingTargetSamples = {
    up: [{ namespace: "prod", service: "beta-harness-center-metrics", value: 1 }],
    rpcRates: [],
  };
  assert.equal(evaluateScopedAlerts(alphaRule, missingTargetSamples).downFires, true);
  assert.equal(evaluateScopedAlerts(betaRule, missingTargetSamples).downFires, false);

  // Case 2: alpha has 20% error rate (20/100) while high-volume beta has 0.1% error rate (10/10000);
  // global unscoped ratio would be 0.29% (< 5%), but scoped alpha MUST fire and beta MUST NOT
  const mixedErrorSamples = {
    up: [
      { namespace: "prod", service: "alpha-harness-center-metrics", value: 1 },
      { namespace: "prod", service: "beta-harness-center-metrics", value: 1 },
    ],
    rpcRates: [
      { namespace: "prod", service: "alpha-harness-center-metrics", outcome: "error", rate: 20 },
      { namespace: "prod", service: "alpha-harness-center-metrics", outcome: "ok", rate: 80 },
      { namespace: "prod", service: "beta-harness-center-metrics", outcome: "error", rate: 10 },
      { namespace: "prod", service: "beta-harness-center-metrics", outcome: "ok", rate: 9_990 },
    ],
  };
  assert.equal(evaluateScopedAlerts(alphaRule, mixedErrorSamples).rpcErrorFires, true);
  assert.equal(evaluateScopedAlerts(betaRule, mixedErrorSamples).rpcErrorFires, false);

  // Negative regression fixtures: unscoped absent() and unscoped sum(rate(...)) are rejected
  const unscopedRules = `
        - alert: HarnessDaemonDown
          expr: up{job="alpha"} == 0 or absent(ha_daemon_up) == 1
        - alert: HarnessWriteQueueSaturated
          expr: ha_daemon_write_queue_depth_total > 32
        - alert: HarnessProjectionLagHigh
          expr: ha_daemon_projection_lag_revisions_max > 500
        - alert: HarnessRpcErrorRateHigh
          expr: |
            (
              sum(rate(ha_daemon_rpc_requests_total{outcome="error"}[5m]))
              / clamp_min(sum(rate(ha_daemon_rpc_requests_total[5m])), 1e-9)
            ) > 0.05
  `;
  const negativeIssues = validatePrometheusRuleSemantics(unscopedRules);
  assert.ok(negativeIssues.some((issue) => issue.includes("HarnessDaemonDown")));
  assert.ok(negativeIssues.some((issue) => issue.includes("HarnessRpcErrorRateHigh")));
  assert.ok(negativeIssues.some((issue) => issue.includes("HarnessWriteQueueSaturated")));
  assert.ok(negativeIssues.some((issue) => issue.includes("HarnessProjectionLagHigh")));
});

test("start-center.sh enforces PG storage, reconciles Fleet upgrades/disable, rejects OIDC drift, and preserves signal-safe PID 1 drain", async () => {
  const configmap = readFileSync(path.join(templatesRoot, "configmap.yaml"), "utf8");
  const deployment = readFileSync(path.join(templatesRoot, "deployment.yaml"), "utf8");
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  const entrypointScript = extractEntrypointScript();

  const daemonConsumers = [
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/metrics-http-server.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/runtime-relay-target.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/daemon-host-open.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/daemon-host-lifecycle-api.ts"), "utf8"),
  ].join("\n");

  // Every env key emitted by the chart has a real consumer
  const emittedEnvKeys = new Set([
    ...[...configmap.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gmu)].map((match) => match[1]),
    ...[...deployment.matchAll(/-\s*name:\s*([A-Z][A-Z0-9_]+)/gu)].map((match) => match[1]),
    ...[...statefulset.matchAll(/-\s*name:\s*([A-Z][A-Z0-9_]+)/gu)].map((match) => match[1]),
  ]);
  const nodeBuiltinEnvs = new Set(["NODE_EXTRA_CA_CERTS"]);
  assert.ok(emittedEnvKeys.size >= 12, "expected chart env keys to be checked");
  for (const key of emittedEnvKeys) {
    const consumed = nodeBuiltinEnvs.has(key) || daemonConsumers.includes(key) || entrypointScript.includes(key);
    assert.ok(consumed, `Helm chart emits unconsumed environment variable: ${key}`);
  }

  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-helm-entrypoint-"));
  try {
    const scriptPath = path.join(sandbox, "start-center.sh");
    const userRoot = path.join(sandbox, "user");
    const repoRootDir = path.join(sandbox, "repos", "center");
    const repoRootV2Dir = path.join(sandbox, "repos", "center-v2");
    const oidcDir = path.join(sandbox, "oidc");
    const tlsDir = path.join(sandbox, "fleet-tls");
    const daemonLog = path.join(sandbox, "daemon-calls.jsonl");
    const cliLog = path.join(sandbox, "cli-calls.jsonl");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(oidcDir, { recursive: true });
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(scriptPath, entrypointScript, { mode: 0o755 });
    writeFileSync(path.join(oidcDir, "client-secret"), "oidc-secret-value-42\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.crt"), "DUMMY-CERT\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.key"), "DUMMY-KEY\n", { mode: 0o600 });

    // Deterministic event-driven stub daemon (zero fixed wall-clock shutdown timers):
    // - If STUB_WAIT_FOR_TERM=1 (or when rbac/config.json is absent during bootstrap), stays alive until SIGTERM,
    //   then drains (optionally waiting for a drain gate file) and exits cleanly.
    // - In exec steady-state mode (rbac/config.json already present), records its launch and exits immediately.
    const stubDaemon = path.join(sandbox, "stub-daemon.cjs");
    const stubCli = path.join(sandbox, "stub-cli.cjs");
    writeFileSync(
      stubDaemon,
      `
const fs = require("node:fs");
const path = require("node:path");
const userRoot = process.env.HARNESS_DAEMON_USER_ROOT;
const readyFlag = process.env.STUB_READY_FILE;
const drainStarted = process.env.STUB_DRAIN_STARTED_FILE;
const drainMarker = process.env.STUB_DRAIN_COMPLETE_FILE;
const drainGate = process.env.STUB_DRAIN_GATE_FILE;
const hasRbac = fs.existsSync(path.join(userRoot, "rbac", "config.json"));
fs.appendFileSync(${JSON.stringify(daemonLog)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), hasRbac }) + "\\n");
if (hasRbac && process.env.STUB_WAIT_FOR_TERM !== "1") {
  if (readyFlag) fs.writeFileSync(readyFlag, String(process.pid) + "\\n");
  process.exit(0);
}
// Register SIGTERM handler and event-loop keeper BEFORE writing readyFlag so callers cannot race the signal handler.
const keeper = fs.watch(userRoot, () => {});
process.on("SIGTERM", () => {
  if (drainStarted) fs.writeFileSync(drainStarted, "draining\\n");
  const finish = () => {
    keeper.close();
    if (drainMarker) fs.writeFileSync(drainMarker, "drained\\n");
    process.exit(0);
  };
  if (!drainGate || fs.existsSync(drainGate)) {
    finish();
    return;
  }
  const watcher = fs.watch(path.dirname(drainGate), () => {
    if (fs.existsSync(drainGate)) {
      watcher.close();
      finish();
    }
  });
});
if (readyFlag) fs.writeFileSync(readyFlag, String(process.pid) + "\\n");
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
  const url = args[args.indexOf("--url") + 1].replace(/\\/$/, "");
  const realm = args[args.indexOf("--realm") + 1];
  const clientId = args[args.indexOf("--client-id") + 1];
  fs.writeFileSync(path.join(rbacDir, "config.json"), JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external", url, realm, clientId }) + "\\n");
  fs.writeFileSync(path.join(rbacDir, "center-client-secret"), (stdin || "").trim(), { mode: 0o600 });
}
`,
    );

    const sharedEnv = {
      ...process.env,
      HARNESS_DAEMON_ENTRY: stubDaemon,
      HARNESS_CLI_ENTRY: stubCli,
      HARNESS_DAEMON_ID: "center",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_STORAGE_BACKEND: "postgres",
      HARNESS_FLEET_ENABLED: "true",
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
      HARNESS_BOOTSTRAP_WAIT_ATTEMPTS: "10",
      HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "1",
    };

    // F-G7-11: postgres backend without daemon-storage.json must fail closed (never silently fall back to SQLite)
    const missingPgRes = spawnSync("/bin/sh", [scriptPath], { env: sharedEnv, encoding: "utf8" });
    assert.notEqual(missingPgRes.status, 0, "postgres backend without daemon-storage.json must fail closed");
    assert.match(missingPgRes.stderr, /daemon-storage\.json/u);

    // Mount valid PostgreSQL daemon-storage.json
    writeFileSync(
      path.join(userRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
        "org-center-v2": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
      { mode: 0o600 },
    );

    // First boot: seeds registry + center.json, boots temporary daemon, runs external bootstrap, drains it, then execs steady-state daemon
    execFileSync("/bin/sh", [scriptPath], { env: sharedEnv, encoding: "utf8" });

    const registry = readDaemonRegistry({ userRoot });
    assert.equal(registry.invalidRepos.length, 0);
    assert.equal(registry.repos[0]?.repoId, "org-center");
    assert.equal(registry.repos[0]?.canonicalRoot, path.resolve(repoRootDir));

    const fleetConfig = readFleetCenterConfig(userRoot, "center");
    assert.ok(fleetConfig);
    assert.equal(fleetConfig.port, 7545);
    assert.equal(fleetConfig.bind, "0.0.0.0");
    assert.equal(fleetConfig.externalUrl, "https://center.example.org:7545");
    assert.equal(fleetConfig.repoId, "org-center");

    const daemonCalls = readFileSync(daemonLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      daemonCalls.length,
      2,
      "first boot runs bootstrap daemon then hands off via exec to steady-state daemon",
    );
    assert.equal(daemonCalls[0].hasRbac, false);
    assert.equal(daemonCalls[1].hasRbac, true);

    const cliCalls = readFileSync(cliLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bootstrapCall = cliCalls.find((call) => call.args[0] === "bootstrap");
    assert.ok(bootstrapCall);
    assert.equal(bootstrapCall.stdin, "oidc-secret-value-42\n");

    // F-G7-09: Helm upgrade changes Fleet port, bind, externalUrl, and authorityRepoId -> persisted center.json & registry update!
    const upgradedEnv = {
      ...sharedEnv,
      HARNESS_FLEET_BIND: "127.0.0.1",
      HARNESS_FLEET_PORT: "8443",
      HARNESS_FLEET_EXTERNAL_URL: "https://upgraded.example.org:8443",
      HARNESS_FLEET_AUTHORITY_REPO_ID: "org-center-v2",
      HARNESS_FLEET_AUTHORITY_REPO_ROOT: repoRootV2Dir,
    };
    execFileSync("/bin/sh", [scriptPath], { env: upgradedEnv, encoding: "utf8" });
    const upgradedFleet = readFleetCenterConfig(userRoot, "center");
    assert.ok(upgradedFleet);
    assert.equal(upgradedFleet.port, 8443);
    assert.equal(upgradedFleet.bind, "127.0.0.1");
    assert.equal(upgradedFleet.externalUrl, "https://upgraded.example.org:8443");
    assert.equal(upgradedFleet.repoId, "org-center-v2");
    assert.ok(
      readDaemonRegistry({ userRoot }).repos.some(
        (repo) => repo.repoId === "org-center-v2" && repo.canonicalRoot === path.resolve(repoRootV2Dir),
      ),
    );
    // Still only 1 bootstrap call (idempotent fast path when OIDC values match)
    assert.equal(
      readFileSync(cliLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((call) => call.args[0] === "bootstrap").length,
      1,
    );

    // F-G7-09: Disabling Fleet cleans up stale persisted center.json so openDaemonHost does not restore old listener
    execFileSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_FLEET_ENABLED: "false" },
      encoding: "utf8",
    });
    assert.equal(readFleetCenterConfig(userRoot, "center"), null, "fleet.enabled=false must remove stale center.json");

    // F-G7-09: OIDC issuer or secret drift fails closed with native rotation instructions and never prints secret values
    const driftedUrlRes = spawnSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_OIDC_ISSUER_URL: "https://new-idp.example.org" },
      encoding: "utf8",
    });
    assert.notEqual(driftedUrlRes.status, 0, "OIDC issuerUrl drift must fail closed");
    assert.match(driftedUrlRes.stderr, /issuerUrl/u);
    assert.match(driftedUrlRes.stderr, /ha bootstrap --operation login/u);

    const rotatedSecretFile = path.join(oidcDir, "rotated-secret");
    writeFileSync(rotatedSecretFile, "super-sensitive-rotated-secret-999\n", { mode: 0o600 });
    const driftedSecretRes = spawnSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_OIDC_CLIENT_SECRET_FILE: rotatedSecretFile },
      encoding: "utf8",
    });
    assert.notEqual(driftedSecretRes.status, 0, "OIDC client secret drift must fail closed");
    assert.match(driftedSecretRes.stderr, /clientSecret/u);
    assert.ok(
      !driftedSecretRes.stderr.includes("super-sensitive-rotated-secret-999"),
      "OIDC drift diagnostic must never print secret values",
    );

    // F-G7-14: SIGTERM during first-boot bootstrap waits until background daemon finishes draining before PID 1 exits
    const drainRoot = path.join(sandbox, "drain-user");
    mkdirSync(drainRoot, { recursive: true });
    writeFileSync(
      path.join(drainRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
    );
    const readyFile = path.join(sandbox, "drain-ready");
    const drainStartedFile = path.join(sandbox, "drain-started");
    const drainGateFile = path.join(sandbox, "drain-gate");
    const drainCompleteFile = path.join(sandbox, "drain-complete");
    const slowCli = path.join(sandbox, "slow-cli.cjs");
    // Returns non-zero on daemon status so start-center.sh stays in the bootstrap wait loop until SIGTERM arrives
    writeFileSync(slowCli, "process.exit(1);\n");

    const shellChild = spawn("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: drainRoot,
        HARNESS_CLI_ENTRY: slowCli,
        HARNESS_BOOTSTRAP_WAIT_ATTEMPTS: "60",
        HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "1",
        STUB_READY_FILE: readyFile,
        STUB_DRAIN_STARTED_FILE: drainStartedFile,
        STUB_DRAIN_GATE_FILE: drainGateFile,
        STUB_DRAIN_COMPLETE_FILE: drainCompleteFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForFile(readyFile);
    let shellExited = false;
    const shellExitPromise = new Promise((resolve) => {
      shellChild.once("exit", (code, signal) => {
        shellExited = true;
        resolve({ code, signal });
      });
    });

    // Send SIGTERM to start-center.sh while daemon has not yet completed drain
    shellChild.kill("SIGTERM");
    // Wait deterministically for the daemon to receive the forwarded SIGTERM and enter drain
    await waitForFile(drainStartedFile);
    assert.equal(shellExited, false, "PID 1 shell must not exit before background daemon completes drain");
    assert.equal(existsSync(drainCompleteFile), false);

    // Release daemon drain gate; daemon finishes drain, writes drainCompleteFile, then PID 1 exits
    writeFileSync(drainGateFile, "go\n");
    await shellExitPromise;
    assert.equal(existsSync(drainCompleteFile), true, "daemon must have finished draining before PID 1 exited");
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
