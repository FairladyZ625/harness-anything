// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { PROMETHEUS_METRIC_NAMES } from "../packages/kernel/src/domain/prometheus-metrics.ts";
import { readDaemonRegistry } from "../packages/kernel/src/daemon/registry.ts";
import { readFleetCenterConfig } from "../packages/daemon/src/daemon-host/fleet-center-config.ts";
import { openDaemonHost } from "../packages/daemon/src/daemon-host/daemon-host.ts";
import { createIdentityReadinessController } from "../packages/daemon/src/daemon-host/daemon-host-lifecycle-api.ts";
import { startDaemonMetricsServer } from "../packages/daemon/src/daemon-host/metrics-http-server.ts";
import { sqliteLedgerPath } from "../packages/storage/src/store/sqlite-ledger-layout.ts";

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

function renderHelmNames({ releaseName, chartName = "harness-center", nameOverride = "", fullnameOverride = "" }) {
  const trunc = (value, maxLen) => value.slice(0, maxLen).replace(/-+$/u, "");
  const sha8 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 8);
  const name = trunc(nameOverride || chartName, 63);
  const fullname = fullnameOverride
    ? trunc(fullnameOverride, 63)
    : `${trunc(`${releaseName}-${name}`, 42)}-${sha8(releaseName)}`;
  const derived = (suffix, directMax, hashPrefixMax) =>
    fullname.length <= directMax
      ? `${fullname}-${suffix}`
      : `${trunc(fullname, hashPrefixMax)}-${sha8(fullname)}-${suffix}`;
  return {
    fullname,
    fleetServiceName: derived("fleet", 57, 48),
    metricsServiceName: derived("metrics", 55, 46),
    headlessServiceName: derived("headless", 54, 45),
    entrypointConfigMapName: derived("entrypoint", 52, 43),
  };
}

function validateHelmValuesRender(values) {
  const errors = [];
  if (Number(values.replicaCount) !== 1) errors.push("replicaCount must equal 1");
  if (values.storage?.backend === "postgres" && !values.storage?.existingSecret) {
    errors.push("storage.existingSecret is required when storage.backend=postgres");
  }
  if (values.storage?.backend === "sqlite" && values.workloadKind === "Deployment" && !values.persistence?.enabled) {
    errors.push("storage.backend=sqlite requires workloadKind=StatefulSet or persistence.enabled=true");
  }
  if (values.fleet?.enabled && values.metrics?.enabled && Number(values.fleet.port) === Number(values.metrics.port)) {
    errors.push("fleet.port and metrics.port must be distinct when both fleet.enabled and metrics.enabled are true");
  }
  const trimSlash = (value) => String(value ?? "").replace(/\/+$/u, "");
  if (values.fleet?.enabled && trimSlash(values.daemon?.userRoot) === trimSlash(values.fleet?.authorityRepoRoot)) {
    errors.push("fleet.authorityRepoRoot must not equal daemon.userRoot");
  }
  return errors;
}

function renderPrometheusRuleForRelease(template, { releaseName, namespace, metricsServiceName, rpcThreshold = 0.05 }) {
  return template
    .replace(/\{\{-\s*if[\s\S]*?\}\}\n?/u, "")
    .replace(/\{\{-\s*\$ns\s*:=[\s\S]*?\}\}\n?/u, "")
    .replace(/\{\{-\s*\$svc\s*:=[\s\S]*?\}\}\n?/u, "")
    .replace(/\{\{\s*\.Release\.Name\s*\|\s*quote\s*\}\}/gu, JSON.stringify(releaseName))
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
    if (!/\brelease:\s*"[^"]+"/u.test(downBlock)) {
      issues.push("HarnessDaemonDown must attach a release label to emitted alerts.");
    }
  }

  const rpcErrorBlock = /-\s*alert:\s*HarnessRpcErrorRateHigh[\s\S]*?(?=\n\s*-\s*alert:|\n\{\{-?\s*end\b|$)/u.exec(
    prometheusRuleText,
  )?.[0];
  if (!rpcErrorBlock) {
    issues.push("Missing HarnessRpcErrorRateHigh alert rule.");
  } else {
    const numeratorScoped =
      /\bsum\s+by\s*\(\s*namespace\s*,\s*service\s*\)\s*\(\s*rate\(\s*ha_daemon_rpc_requests_total\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*outcome="error"[^}]*\}\[5m\]\s*\)\s*\)/u.test(
        rpcErrorBlock,
      );
    const denominatorScoped =
      /\bsum\s+by\s*\(\s*namespace\s*,\s*service\s*\)\s*\(\s*rate\(\s*ha_daemon_rpc_requests_total\{[^}]*namespace="[^"]+"[^}]*service="[^"]+"[^}]*\}\[5m\]\s*\)\s*\)/u.test(
        rpcErrorBlock,
      );
    if (!numeratorScoped || !denominatorScoped) {
      issues.push(
        "HarnessRpcErrorRateHigh must preserve grouping labels with sum by (namespace, service) and scope both numerator and denominator to release namespace and metrics service labels.",
      );
    }
    if (!/\brelease:\s*"[^"]+"/u.test(rpcErrorBlock)) {
      issues.push("HarnessRpcErrorRateHigh must attach a release label to emitted alerts.");
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
    if (!block || !/\brelease:\s*"[^"]+"/u.test(block)) {
      issues.push(`${alertName} must attach a release label to emitted alerts.`);
    }
  }
  return issues;
}

function evaluateScopedAlerts(renderedRule, samples) {
  const downBlock = /-\s*alert:\s*HarnessDaemonDown[\s\S]*?(?=\n\s*-\s*alert:|$)/u.exec(renderedRule)?.[0] ?? "";
  const downExpr = /expr:\s*(.+)/u.exec(downBlock)?.[1]?.trim() ?? "";
  const downSelector = /up\{namespace="([^"]+)",service="([^"]+)"\}/u.exec(downExpr);
  const downRelease = /\brelease:\s*"([^"]+)"/u.exec(downBlock)?.[1] ?? null;
  assert.ok(downSelector, `expected scoped up selector in HarnessDaemonDown: ${downExpr}`);
  const [, ns, svc] = downSelector;
  const matchingUp = samples.up.filter((s) => s.namespace === ns && s.service === svc);
  const downFires = matchingUp.length === 0 || matchingUp.some((s) => s.value === 0);
  const downAlerts = downFires
    ? [
        {
          alertname: "HarnessDaemonDown",
          severity: "critical",
          namespace: ns,
          service: svc,
          ...(downRelease ? { release: downRelease } : {}),
        },
      ]
    : [];

  const rpcBlock = /-\s*alert:\s*HarnessRpcErrorRateHigh[\s\S]*?(?=\n\s*-\s*alert:|$)/u.exec(renderedRule)?.[0] ?? "";
  const rpcExpr = /expr:\s*\|([\s\S]*?)\n\s+for:/u.exec(rpcBlock)?.[1] ?? "";
  const rpcRelease = /\brelease:\s*"([^"]+)"/u.exec(rpcBlock)?.[1] ?? null;
  const rpcThreshold = Number(/>\s*([0-9.]+)/u.exec(rpcExpr)?.[1] ?? "NaN");
  const numSel =
    /sum\s+by\s*\(\s*namespace\s*,\s*service\s*\)\s*\(rate\(ha_daemon_rpc_requests_total\{namespace="([^"]+)",service="([^"]+)",outcome="error"\}/u.exec(
      rpcExpr,
    );
  const denSel =
    /clamp_min\(sum\s+by\s*\(\s*namespace\s*,\s*service\s*\)\s*\(rate\(ha_daemon_rpc_requests_total\{namespace="([^"]+)",service="([^"]+)"\}/u.exec(
      rpcExpr,
    );
  assert.ok(numSel && denSel, `expected grouped scoped RPC selectors in HarnessRpcErrorRateHigh: ${rpcExpr}`);
  const errRate = samples.rpcRates
    .filter((s) => s.namespace === numSel[1] && s.service === numSel[2] && s.outcome === "error")
    .reduce((sum, s) => sum + s.rate, 0);
  const totalRate = samples.rpcRates
    .filter((s) => s.namespace === denSel[1] && s.service === denSel[2])
    .reduce((sum, s) => sum + s.rate, 0);
  const rpcErrorFires = errRate / Math.max(totalRate, 1e-9) > rpcThreshold;
  const rpcAlerts = rpcErrorFires
    ? [
        {
          alertname: "HarnessRpcErrorRateHigh",
          severity: "warning",
          namespace: numSel[1],
          service: numSel[2],
          ...(rpcRelease ? { release: rpcRelease } : {}),
        },
      ]
    : [];

  return { downFires, rpcErrorFires, downAlerts, rpcAlerts };
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

  // F-G7-11 & F-G7-29: postgres requires non-empty existingSecret; sqlite rejects unpersisted Deployment and allows StatefulSet or Deployment+persistence
  assert.equal(
    validate({ ...values, storage: { ...values.storage, backend: "postgres", existingSecret: "" } }),
    false,
    "schema must reject postgres backend without existingSecret",
  );
  assert.equal(
    validate({
      ...values,
      workloadKind: "Deployment",
      persistence: { ...values.persistence, enabled: false },
      storage: { ...values.storage, backend: "sqlite", existingSecret: "" },
    }),
    false,
    "schema must reject unpersisted Deployment with sqlite backend",
  );
  assert.equal(
    validate({
      ...values,
      workloadKind: "StatefulSet",
      storage: { ...values.storage, backend: "sqlite", existingSecret: "" },
    }),
    true,
    "schema must allow StatefulSet with sqlite backend without existingSecret",
  );
  assert.equal(
    validate({
      ...values,
      workloadKind: "Deployment",
      persistence: { ...values.persistence, enabled: true },
      storage: { ...values.storage, backend: "sqlite", existingSecret: "" },
    }),
    true,
    "schema must allow Deployment with persistence.enabled=true and sqlite backend",
  );

  // F-G7-13 & F-G7-23: reject reserved probe paths, dot/traversal segments, trailing slashes, non-ASCII, and percent-encoding
  for (const forbidden of [
    "/",
    "/healthz",
    "/readyz",
    "/healthz/",
    "/readyz/",
    "//healthz",
    "/./readyz",
    "/a/../healthz",
    "/metrics/",
    "/指标",
    "/%6detrics",
    "/metrics%2Fsub",
    "/metrics?x=1",
  ]) {
    assert.equal(
      validate({ ...values, metrics: { ...values.metrics, path: forbidden } }),
      false,
      `values.schema.json must reject metrics.path=${forbidden}`,
    );
  }
  for (const allowed of ["/metrics", "/custom/metrics", "/healthz-metrics", "/v1.0/prom_metrics-1"]) {
    assert.equal(
      validate({ ...values, metrics: { ...values.metrics, path: allowed } }),
      true,
      `values.schema.json must allow metrics.path=${allowed}`,
    );
  }

  // F-G7-22: setting bearerTokenExistingSecret requires non-empty bearerTokenSecretKey
  assert.equal(
    validate({
      ...values,
      metrics: { ...values.metrics, bearerTokenExistingSecret: "prom-bearer", bearerTokenSecretKey: "" },
    }),
    false,
    "schema must reject empty bearerTokenSecretKey when bearerTokenExistingSecret is set",
  );
  assert.equal(
    validate({
      ...values,
      metrics: { ...values.metrics, bearerTokenExistingSecret: "prom-bearer", bearerTokenSecretKey: "token" },
    }),
    true,
    "schema must allow non-empty bearerTokenExistingSecret + bearerTokenSecretKey",
  );
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

  // F-G7-18 & F-G7-28: release-unique injective base + explicit role suffixes prevent ALL cross-release Service/ConfigMap collisions
  assert.ok(helpers.includes('define "harness-center.fleetServiceName"'));
  assert.ok(helpers.includes('define "harness-center.entrypointConfigMapName"'));
  assert.ok(helpers.includes(".Release.Name | sha256sum | trunc 8"));
  assert.ok(helpers.includes("trunc 48") && helpers.includes("trunc 46") && helpers.includes("sha256sum | trunc 8"));
  assert.ok(helpers.includes("trunc 45") && helpers.includes("trunc 43"));
  assert.ok(fleetService.includes('name: {{ include "harness-center.fleetServiceName" . }}'));
  assert.ok(deployment.includes('name: {{ include "harness-center.entrypointConfigMapName" . }}'));
  assert.ok(statefulset.includes('name: {{ include "harness-center.entrypointConfigMapName" . }}'));

  // F-G7-27: render-time validation rejects overlapping fleet.port and metrics.port (even when TLS secret is unset & service.type=LoadBalancer)
  assert.ok(
    helpers.includes("eq (int .Values.fleet.port) (int .Values.metrics.port)"),
    "_helpers.tpl validateValues must reject overlapping fleet.port and metrics.port",
  );
  const defaultValues = parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8"));
  assert.deepEqual(validateHelmValuesRender(defaultValues), []);
  const overlappingPortErrors = validateHelmValuesRender({
    ...defaultValues,
    service: { ...defaultValues.service, type: "LoadBalancer" },
    fleet: { ...defaultValues.fleet, enabled: true, port: defaultValues.metrics.port, tlsExistingSecret: "" },
    metrics: { ...defaultValues.metrics, enabled: true },
  });
  assert.ok(
    overlappingPortErrors.some((entry) => entry.includes("fleet.port and metrics.port must be distinct")),
    "overlapping Fleet and metrics container ports must fail render-time validation",
  );
  // Distinct container ports render distinct targetPorts on Fleet vs Metrics Services
  assert.notEqual(defaultValues.fleet.port, defaultValues.metrics.port);
  assert.ok(deployment.includes("containerPort: {{ .Values.fleet.port }}"));
  assert.ok(deployment.includes("containerPort: {{ .Values.metrics.port }}"));
  assert.ok(statefulset.includes("containerPort: {{ .Values.fleet.port }}"));
  assert.ok(statefulset.includes("containerPort: {{ .Values.metrics.port }}"));
  assert.ok(fleetService.includes("targetPort: fleet-tls"));
  assert.ok(metricsService.includes("targetPort: metrics"));

  // F-G7-29: StatefulSet and Deployment mount daemon-state PVC on BOTH daemon.userRoot (subPath: user) and fleet.authorityRepoRoot (subPath: authority-repo)
  assert.ok(
    helpers.includes('eq .Values.storage.backend "sqlite"') && helpers.includes("not .Values.persistence.enabled"),
  );
  assert.ok(helpers.includes("fleet.authorityRepoRoot"));
  assert.ok(statefulset.includes("subPath: user") && statefulset.includes("subPath: authority-repo"));
  assert.ok(statefulset.includes("mountPath: {{ .Values.fleet.authorityRepoRoot | quote }}"));
  assert.ok(deployment.includes("subPath: user") && deployment.includes("subPath: authority-repo"));
  assert.ok(deployment.includes("mountPath: {{ .Values.fleet.authorityRepoRoot | quote }}"));
  const sameMountErrors = validateHelmValuesRender({
    ...defaultValues,
    fleet: { ...defaultValues.fleet, authorityRepoRoot: defaultValues.daemon.userRoot },
  });
  assert.ok(sameMountErrors.some((entry) => entry.includes("authorityRepoRoot")));

  const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  const namingCases = [
    { label: "prod", releaseName: "prod" },
    { label: "prod-harness-center", releaseName: "prod-harness-center" },
    { label: "prod-harness-center-metrics", releaseName: "prod-harness-center-metrics" },
    { label: "prod-harness-center-fleet", releaseName: "prod-harness-center-fleet" },
    { label: "prod-harness-center-headless", releaseName: "prod-harness-center-headless" },
    { label: "50-char-release", releaseName: "r".repeat(50) },
    { label: "53-char-release-a", releaseName: `${"r".repeat(52)}a` },
    { label: "53-char-release-b", releaseName: `${"r".repeat(52)}b` },
    { label: "63-char-fullnameOverride", releaseName: "prod", fullnameOverride: "a".repeat(63) },
    {
      label: "adversarial-metrics-override",
      releaseName: "prod",
      fullnameOverride: `${"a".repeat(55)}-metrics`,
    },
    {
      label: "adversarial-headless-override",
      releaseName: "prod",
      fullnameOverride: `${"a".repeat(54)}-headless`,
    },
  ];
  const renderedByLabel = new Map();
  for (const namingCase of namingCases) {
    const names = renderHelmNames(namingCase);
    renderedByLabel.set(namingCase.label, names);
    const allNames = [
      names.fullname,
      names.fleetServiceName,
      names.metricsServiceName,
      names.headlessServiceName,
      names.entrypointConfigMapName,
    ];
    for (const candidate of allNames) {
      assert.ok(
        candidate.length <= 63 && dnsLabelPattern.test(candidate),
        `${namingCase.label}: invalid K8s DNS label ${candidate} (len=${candidate.length})`,
      );
    }
    assert.equal(
      new Set(allNames).size,
      5,
      `${namingCase.label}: base, Fleet, metrics, headless Services and entrypoint ConfigMap must never collide: ${JSON.stringify(names)}`,
    );
  }
  // F-G7-28: ALL default releases installed in the same namespace produce zero Service or ConfigMap name collisions across pairs!
  const defaultReleaseLabels = [
    "prod",
    "prod-harness-center",
    "prod-harness-center-metrics",
    "prod-harness-center-fleet",
    "prod-harness-center-headless",
    "50-char-release",
    "53-char-release-a",
    "53-char-release-b",
  ];
  const allServiceNamesAcrossReleases = new Set();
  const allConfigMapNamesAcrossReleases = new Set();
  for (const label of defaultReleaseLabels) {
    const names = renderedByLabel.get(label);
    for (const svc of [names.fleetServiceName, names.metricsServiceName, names.headlessServiceName]) {
      assert.equal(
        allServiceNamesAcrossReleases.has(svc),
        false,
        `cross-release Service collision on ${svc} for release ${label}`,
      );
      allServiceNamesAcrossReleases.add(svc);
    }
    for (const cm of [names.fullname, names.entrypointConfigMapName]) {
      assert.equal(
        allConfigMapNamesAcrossReleases.has(cm),
        false,
        `cross-release ConfigMap collision on ${cm} for release ${label}`,
      );
      allConfigMapNamesAcrossReleases.add(cm);
    }
  }
  // Upgrade stability: re-rendering the same release name produces identical deterministic names
  assert.deepEqual(renderHelmNames({ releaseName: "prod" }), renderedByLabel.get("prod"));

  // F-G7-12: Fleet Service exposes ONLY fleet-tls (supporting ClusterIP/NodePort/LoadBalancer);
  // Metrics Service is ALWAYS ClusterIP and exposes ONLY metrics; Headless Service is clusterIP: None for StatefulSet
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

  // F-G7-08 & F-G7-19: multi-release PromQL scoping & distinct alert label sets when firing simultaneously
  const alphaRule = renderPrometheusRuleForRelease(prometheusRule, {
    releaseName: "alpha",
    namespace: "prod",
    metricsServiceName: "alpha-harness-center-metrics",
  });
  const betaRule = renderPrometheusRuleForRelease(prometheusRule, {
    releaseName: "beta",
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

  // Case 3 (F-G7-19): BOTH alpha and beta exceed RPC error threshold and are down simultaneously ->
  // must emit TWO DISTINCT alert label sets (never collapsed to identical {alertname, severity})
  const dualFiringSamples = {
    up: [
      { namespace: "prod", service: "alpha-harness-center-metrics", value: 0 },
      { namespace: "prod", service: "beta-harness-center-metrics", value: 0 },
    ],
    rpcRates: [
      { namespace: "prod", service: "alpha-harness-center-metrics", outcome: "error", rate: 25 },
      { namespace: "prod", service: "alpha-harness-center-metrics", outcome: "ok", rate: 75 },
      { namespace: "prod", service: "beta-harness-center-metrics", outcome: "error", rate: 40 },
      { namespace: "prod", service: "beta-harness-center-metrics", outcome: "ok", rate: 60 },
    ],
  };
  const alphaEval = evaluateScopedAlerts(alphaRule, dualFiringSamples);
  const betaEval = evaluateScopedAlerts(betaRule, dualFiringSamples);
  assert.equal(alphaEval.rpcAlerts.length, 1);
  assert.equal(betaEval.rpcAlerts.length, 1);
  assert.notDeepEqual(
    alphaEval.rpcAlerts[0],
    betaEval.rpcAlerts[0],
    "simultaneously firing RPC alerts from two releases must carry distinct label sets",
  );
  assert.equal(alphaEval.rpcAlerts[0].release, "alpha");
  assert.equal(betaEval.rpcAlerts[0].release, "beta");
  assert.equal(alphaEval.rpcAlerts[0].service, "alpha-harness-center-metrics");
  assert.equal(betaEval.rpcAlerts[0].service, "beta-harness-center-metrics");
  assert.notDeepEqual(alphaEval.downAlerts[0], betaEval.downAlerts[0]);
  assert.equal(alphaEval.downAlerts[0].release, "alpha");
  assert.equal(betaEval.downAlerts[0].release, "beta");

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

    // F-G7-09 & F-G7-20: OIDC issuer or secret drift fails closed with actionable rotate-before-upgrade / rollback instructions
    // (never telling operators to exec into the exited pod's unstarted daemon socket) and never prints secret values
    const driftedUrlRes = spawnSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_OIDC_ISSUER_URL: "https://new-idp.example.org" },
      encoding: "utf8",
    });
    assert.notEqual(driftedUrlRes.status, 0, "OIDC issuerUrl drift must fail closed");
    assert.match(driftedUrlRes.stderr, /issuerUrl/u);
    assert.match(driftedUrlRes.stderr, /roll back/iu);
    assert.match(driftedUrlRes.stderr, /ha bootstrap --operation login/u);
    assert.doesNotMatch(
      driftedUrlRes.stderr,
      /against the pod daemon socket/iu,
      "drift message must not instruct operators to connect to the exited pod's unstarted daemon socket",
    );
    const opsDoc = readFileSync(path.join(repoRoot, "docs-release/observability-and-deployment.md"), "utf8");
    assert.match(opsDoc, /Rotating or changing external OIDC/u);
    assert.match(opsDoc, /helm rollback/u);

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

    // F-G7-17: 2-repo upgrade / Secret removal — org-center and org-center-v2 are both enabled in registry.json;
    // removing org-center from daemon-storage.json must fail closed BEFORE invoking daemon (never opening SQLite for org-center)
    const daemonLinesBefore = readFileSync(daemonLog, "utf8").trim().split("\n").length;
    writeFileSync(
      path.join(userRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center-v2": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
      { mode: 0o600 },
    );
    const missingSecondRepoPg = spawnSync("/bin/sh", [scriptPath], { env: upgradedEnv, encoding: "utf8" });
    assert.notEqual(
      missingSecondRepoPg.status,
      0,
      "removing a registered enabled repo from PG Secret must fail closed before daemon launch",
    );
    assert.match(missingSecondRepoPg.stderr, /org-center/u);
    assert.equal(
      readFileSync(daemonLog, "utf8").trim().split("\n").length,
      daemonLinesBefore,
      "daemon must NOT be started (and no SQLite ledger opened) when any enabled registered repo lacks PG config",
    );

    // F-G7-22: Malformed PG Secret containing a synthetic credential must fail closed with redacted error (zero secret leakage)
    const secretToken = "SYNTHETIC_PG_SECRET_TOKEN_778899";
    writeFileSync(
      path.join(userRoot, "daemon-storage.json"),
      `{"org-center": {"connectionString": "postgresql://admin:${secretToken}@db.internal/ha" INVALID_JSON`,
      { mode: 0o600 },
    );
    const badJsonRes = spawnSync("/bin/sh", [scriptPath], { env: upgradedEnv, encoding: "utf8" });
    assert.notEqual(badJsonRes.status, 0, "malformed daemon-storage.json must fail closed");
    assert.match(badJsonRes.stderr, /not valid JSON \(parse details redacted\)/u);
    assert.ok(
      !badJsonRes.stdout.includes(secretToken) && !badJsonRes.stderr.includes(secretToken),
      "malformed PG Secret parse diagnostic must never leak secret contents",
    );

    // F-G7-22: Empty/whitespace metrics bearer token when HARNESS_DAEMON_METRICS_REQUIRE_AUTH=1 fails closed before daemon start
    const emptyBearerRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_DAEMON_METRICS_REQUIRE_AUTH: "1",
        HARNESS_DAEMON_METRICS_BEARER_TOKEN: "   ",
      },
      encoding: "utf8",
    });
    assert.notEqual(emptyBearerRes.status, 0, "empty metrics bearer token must fail closed");
    assert.match(emptyBearerRes.stderr, /HARNESS_DAEMON_METRICS_BEARER_TOKEN/u);
    assert.equal(
      readFileSync(daemonLog, "utf8").trim().split("\n").length,
      daemonLinesBefore,
      "daemon must NOT start when configured metrics bearer token is empty",
    );

    // F-G7-27: Overlapping HARNESS_FLEET_PORT and HARNESS_DAEMON_METRICS_PORT fails closed before daemon start
    const overlapPortRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_FLEET_ENABLED: "true",
        HARNESS_FLEET_PORT: "9090",
        HARNESS_DAEMON_METRICS_PORT: "9090",
      },
      encoding: "utf8",
    });
    assert.notEqual(
      overlapPortRes.status,
      0,
      "overlapping Fleet and metrics ports must fail closed in start-center.sh",
    );
    assert.match(overlapPortRes.stderr, /HARNESS_FLEET_PORT.*HARNESS_DAEMON_METRICS_PORT/u);
    assert.equal(
      readFileSync(daemonLog, "utf8").trim().split("\n").length,
      daemonLinesBefore,
      "daemon must NOT start when Fleet and metrics share the same container port",
    );

    // F-G7-31: First-time bootstrap returning exit 0 with authoritySync.pending=true must fail closed instead of restarting blindly
    const pendingBootRoot = path.join(sandbox, "pending-boot-user");
    mkdirSync(pendingBootRoot, { recursive: true });
    writeFileSync(
      path.join(pendingBootRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
    );
    const pendingBootstrapCli = path.join(sandbox, "pending-bootstrap-cli.cjs");
    writeFileSync(
      pendingBootstrapCli,
      `
const args = process.argv.slice(2);
if (args[0] === "bootstrap") {
  process.stdout.write(JSON.stringify({ ok: true, mode: "external", authoritySync: { ok: false, pending: true, code: "oidc_discovery_unavailable" } }) + "\\n");
}
process.exit(0);
`,
    );
    const pendingBootRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: pendingBootRoot,
        HARNESS_CLI_ENTRY: pendingBootstrapCli,
      },
      encoding: "utf8",
    });
    assert.notEqual(
      pendingBootRes.status,
      0,
      "bootstrap reporting authoritySync.pending=true must fail closed in start-center.sh",
    );
    assert.match(pendingBootRes.stderr, /authoritySync\.pending=true/u);

    // F-G7-14 & F-G7-21: SIGTERM during blocked bootstrap CLI (not just wait-loop sleep) interrupts immediately,
    // triggers daemon drain, waits for drain completion, and preserves real child exit codes on crashes/failures
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
    const bootstrapStartedFile = path.join(sandbox, "bootstrap-started");
    const drainStartedFile = path.join(sandbox, "drain-started");
    const drainGateFile = path.join(sandbox, "drain-gate");
    const drainCompleteFile = path.join(sandbox, "drain-complete");
    const blockingBootstrapCli = path.join(sandbox, "blocking-bootstrap-cli.cjs");
    // daemon status succeeds immediately, then `bootstrap` writes bootstrapStartedFile and blocks indefinitely
    writeFileSync(
      blockingBootstrapCli,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "daemon" && args[1] === "status") process.exit(0);
if (args[0] === "bootstrap") {
  fs.writeFileSync(${JSON.stringify(bootstrapStartedFile)}, String(process.pid) + "\\n");
  const keeper = fs.watch(${JSON.stringify(sandbox)}, () => {});
  process.on("SIGTERM", () => {
    keeper.close();
    process.exit(143);
  });
}
`,
    );

    const shellChild = spawn("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: drainRoot,
        HARNESS_CLI_ENTRY: blockingBootstrapCli,
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
    await waitForFile(bootstrapStartedFile);
    let shellExited = false;
    const shellExitPromise = new Promise((resolve) => {
      shellChild.once("exit", (code, signal) => {
        shellExited = true;
        resolve({ code, signal });
      });
    });

    // Send SIGTERM to start-center.sh WHILE `ha bootstrap` CLI is blocked indefinitely
    shellChild.kill("SIGTERM");
    // Must interrupt blocked bootstrap CLI and forward SIGTERM to daemon promptly
    await waitForFile(drainStartedFile);
    assert.equal(shellExited, false, "PID 1 shell must not exit before background daemon completes drain");
    assert.equal(existsSync(drainCompleteFile), false);

    // Release daemon drain gate; daemon finishes drain, writes drainCompleteFile, then PID 1 exits 143
    writeFileSync(drainGateFile, "go\n");
    const exitResult = await shellExitPromise;
    assert.equal(existsSync(drainCompleteFile), true, "daemon must have finished draining before PID 1 exited");
    assert.equal(exitResult.code, 143);

    // F-G7-21: Real non-zero child exit codes are preserved (both crashed daemon and failed bootstrap CLI)
    const crashDaemon = path.join(sandbox, "crash-daemon.cjs");
    writeFileSync(crashDaemon, "process.exit(42);\n");
    const unavailableStatusCli = path.join(sandbox, "unavailable-status-cli.cjs");
    writeFileSync(unavailableStatusCli, "process.exit(1);\n");
    const crashRoot = path.join(sandbox, "crash-user");
    mkdirSync(crashRoot, { recursive: true });
    writeFileSync(
      path.join(crashRoot, "daemon-storage.json"),
      readFileSync(path.join(drainRoot, "daemon-storage.json")),
    );
    const crashRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: crashRoot,
        HARNESS_DAEMON_ENTRY: crashDaemon,
        HARNESS_CLI_ENTRY: unavailableStatusCli,
        HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "0",
      },
      encoding: "utf8",
    });
    assert.equal(crashRes.status, 42, "start-center.sh must preserve real exit code of an already-exited daemon child");

    const failBootRoot = path.join(sandbox, "fail-boot-user");
    mkdirSync(failBootRoot, { recursive: true });
    writeFileSync(
      path.join(failBootRoot, "daemon-storage.json"),
      readFileSync(path.join(drainRoot, "daemon-storage.json")),
    );
    const failBootstrapCli = path.join(sandbox, "fail-bootstrap-cli.cjs");
    writeFileSync(
      failBootstrapCli,
      `const args = process.argv.slice(2); process.exit(args[0] === "bootstrap" ? 7 : 0);\n`,
    );
    const failBootRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: failBootRoot,
        HARNESS_CLI_ENTRY: failBootstrapCli,
      },
      encoding: "utf8",
    });
    assert.equal(failBootRes.status, 7, "start-center.sh must preserve real exit code of failed bootstrap CLI");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("container /readyz tracks live OIDC revocation/recovery and per-target authoritySync.pending (F-G7-20, F-G7-31)", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-helm-oidc-readyz-"));
  const rbacDir = path.join(userRoot, "rbac");
  const workspaceA = path.join(userRoot, "ws-a");
  const workspaceB = path.join(userRoot, "ws-b");
  mkdirSync(rbacDir, { recursive: true });
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });

  let centerHealthy = false;
  let defaultStatusHealthy = false;
  let workspaceAStatusHealthy = false;
  let centerTokenCounter = 0;
  const rejectedTokensSeen = [];
  const statusTargetsSeen = [];
  let configureOutcome = {
    ok: true,
    mode: "external",
    authoritySync: { ok: false, pending: true, code: "oidc_discovery_unavailable", message: "Keycloak down" },
  };
  let configureShouldThrow = true;

  const fakeOidc = {
    configured: () => existsSync(path.join(rbacDir, "config.json")),
    centerConfigured: () =>
      existsSync(path.join(rbacDir, "config.json")) && existsSync(path.join(rbacDir, "center-client-secret")),
    center: async (rejectedAccessToken) => {
      if (rejectedAccessToken !== undefined) rejectedTokensSeen.push(rejectedAccessToken);
      if (!centerHealthy) throw new Error("OIDC client credentials revoked or unreachable");
      centerTokenCounter += 1;
      return {
        url: "https://idp.example.org",
        realm: "fleet",
        accessToken: `tok-${centerTokenCounter}`,
        provider: {},
      };
    },
    status: async (loginTarget) => {
      statusTargetsSeen.push(loginTarget ?? "<default>");
      if (loginTarget === workspaceA) {
        if (!workspaceAStatusHealthy) throw new Error("workspaceA OIDC discovery unavailable");
        return { ok: true, authenticated: false };
      }
      if (!defaultStatusHealthy) throw new Error("default OIDC discovery unavailable");
      return { ok: true, authenticated: false };
    },
    configureAuthority: async (operation) => {
      await operation();
      return configureOutcome;
    },
    bind: async (auth) => auth,
    discovery: () => null,
    begin: async () => ({}),
    complete: async () => ({}),
    beginDevice: async () => ({}),
    deviceApproval: async () => ({}),
    pollDevice: async () => ({}),
    bindingHealth: async () => ({ ok: centerHealthy }),
    logout: async () => ({ ok: true }),
    bootstrapStatus: async () => ({ ok: true, required: false }),
    interactiveAuthority: async () => ({ url: "https://idp.example.org", realm: "fleet", clientId: "harness-center" }),
    requireAccessManagement: async () => {
      throw new Error("not used");
    },
    requireSession: async () => {
      throw new Error("not used");
    },
    serialize: async (op) => op(),
    bootstrapAdmin: async () => ({ ok: true }),
    invite: async () => ({ ok: true }),
  };

  const fakeManagedRbac = {
    run: async () => {
      if (configureShouldThrow) throw new Error("external OIDC endpoint refused connection");
      writeFileSync(
        path.join(rbacDir, "config.json"),
        JSON.stringify({
          schema: "harness-managed-rbac/v1",
          mode: "external",
          url: "https://idp.example.org",
          realm: "fleet",
          clientId: "harness-center",
        }),
      );
      writeFileSync(path.join(rbacDir, "center-client-secret"), "secret-value");
      return { ok: true, mode: "external" };
    },
    resume: async () => undefined,
    stop: async () => undefined,
    loginListenerCertificate: () => null,
  };

  const host = await openDaemonHost({
    daemonId: "helm-oidc-readyz",
    userRoot,
    requireIdentityReady: true,
    identityReadyReverifyIntervalMs: 0,
    oidc: fakeOidc,
    managedRbac: fakeManagedRbac,
  });
  const server = await startDaemonMetricsServer({
    config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
    daemonId: "helm-oidc-readyz",
    collectSnapshot: () => ({
      daemonId: "helm-oidc-readyz",
      version: "0.1.0",
      commit: "test",
      uptimeSeconds: 1,
      processResidentMemoryBytes: 1_000,
      processHeapUsedBytes: 500,
      activeRuntimeSessions: 0,
      rpc: {
        requestsOk: 0,
        requestsError: 0,
        inflight: 0,
        durationBuckets: [],
        durationSumSeconds: 0,
        durationCount: 0,
        quantiles: { p50: 0, p95: 0, p99: 0 },
      },
      fleet: host.observabilitySnapshot().fleet,
      repos: host.observabilitySnapshot().repos,
    }),
    isLive: () => true,
    isReady: () => host.probeSnapshot(),
  });
  const origin = new URL(server.endpoint).origin;
  const settleAsync = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    // 1. Before configuration: /readyz is 503 identity_not_configured
    let res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503);
    assert.ok((await res.json()).reasons.includes("identity_not_configured"));

    // 2. External OIDC initialization throws -> /readyz stays 503
    await assert.rejects(
      () =>
        host.manageRbac(
          { mode: "external", operation: "bootstrap", rootDir: workspaceA },
          { transportKind: "unix-socket" },
        ),
      /refused connection/u,
    );
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503);

    // 3. configureAuthority on workspaceA returns authoritySync.pending === true ->
    //    default scope status(undefined) succeeding MUST NOT clear workspaceA's pending sync!
    configureShouldThrow = false;
    const pendingRes = await host.manageRbac(
      { mode: "external", operation: "bootstrap", rootDir: workspaceA },
      { transportKind: "unix-socket" },
    );
    assert.equal(pendingRes.ok, true);
    assert.equal(pendingRes.authoritySync.pending, true);

    defaultStatusHealthy = true;
    centerHealthy = true;
    workspaceAStatusHealthy = false;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503, "default scope recovery must not clear workspaceA pending authoritySync");
    const stillPending = await res.json();
    assert.ok(
      stillPending.reasons.includes("identity_authority_sync_pending"),
      `expected identity_authority_sync_pending while workspaceA is still failing, got ${JSON.stringify(stillPending)}`,
    );
    assert.ok(
      statusTargetsSeen.includes(workspaceA),
      `expected oidc.status to be invoked with workspaceA target, saw ${JSON.stringify(statusTargetsSeen)}`,
    );

    // 4. Even if workspaceB configures cleanly, workspaceA's pending target remains pending until workspaceA recovers
    configureOutcome = { ok: true, mode: "external" };
    await host.manageRbac(
      { mode: "external", operation: "bootstrap", rootDir: workspaceB },
      { transportKind: "unix-socket" },
    );
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503);
    assert.ok((await res.json()).reasons.includes("identity_authority_sync_pending"));

    // 5. workspaceA discovery recovers -> /readyz transitions to 200 ready
    workspaceAStatusHealthy = true;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");

    // 6. F-G7-31: Upstream service credential is later revoked -> /readyz re-verifies with rejectedAccessToken and transitions to 503 identity_unavailable!
    centerHealthy = false;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503, "revoked upstream credential must transition /readyz from 200 back to 503");
    const revokedBody = await res.json();
    assert.ok(
      revokedBody.reasons.includes("identity_unavailable"),
      `expected identity_unavailable after revocation, got ${JSON.stringify(revokedBody)}`,
    );
    assert.ok(
      rejectedTokensSeen.length >= 1,
      "live re-verification must pass previous accessToken to invalidate cached center token",
    );

    // 7. Upstream recovers -> /readyz transitions back from 503 to 200 ready
    centerHealthy = true;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");

    // Direct controller check: verify throttling respects readyReverifyIntervalMs via injected clock
    let clockMs = 1_000;
    let directCenterCalls = 0;
    const controller = createIdentityReadinessController({
      requireIdentityReady: true,
      hasConfiguredIdentity: () => true,
      ensureRbacResumed: async () => undefined,
      checkOidcStatus: async () => ({ ok: true }),
      checkOidcCenter: async () => {
        directCenterCalls += 1;
        return { accessToken: `direct-${directCenterCalls}` };
      },
      isClosing: () => false,
      nowMs: () => clockMs,
      readyReverifyIntervalMs: 10_000,
    });
    controller.start();
    await settleAsync();
    assert.equal(controller.currentState(), "ready");
    assert.equal(directCenterCalls, 1);
    clockMs += 5_000;
    assert.equal(controller.currentState(), "ready");
    await settleAsync();
    assert.equal(directCenterCalls, 1, "re-verification must stay throttled within readyReverifyIntervalMs");
    clockMs += 5_000;
    assert.equal(controller.currentState(), "ready");
    await settleAsync();
    assert.equal(directCenterCalls, 2, "re-verification must run once readyReverifyIntervalMs elapses");
  } finally {
    await server.close();
    await host.close();
    rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("StatefulSet PVC subPaths persist SQLite authority ledger revision across Pod replacement (F-G7-29)", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-helm-pod-replace-"));
  const pvcRoot = path.join(sandbox, "pvc-daemon-state");
  const pvcUserSubPath = path.join(pvcRoot, "user");
  const pvcAuthorityRepoSubPath = path.join(pvcRoot, "authority-repo");
  mkdirSync(pvcUserSubPath, { recursive: true });
  mkdirSync(pvcAuthorityRepoSubPath, { recursive: true });

  // Verify the rendered StatefulSet mounts cover BOTH daemon.userRoot (subPath: user) and fleet.authorityRepoRoot (subPath: authority-repo)
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  assert.ok(statefulset.includes("subPath: user") && statefulset.includes("subPath: authority-repo"));

  const pod1Ephemeral = path.join(sandbox, "pod-1-rootfs");
  const pod2Ephemeral = path.join(sandbox, "pod-2-rootfs");
  mkdirSync(pod1Ephemeral, { recursive: true });
  mkdirSync(pod2Ephemeral, { recursive: true });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const runGit = (cwd, args) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  };
  try {
    // Initialize a Git repo with canonical roster inside the PVC's authority-repo subPath (mounted at fleet.authorityRepoRoot)
    runGit(pvcAuthorityRepoSubPath, ["init", "-q", "-b", "main"]);
    runGit(pvcAuthorityRepoSubPath, ["config", "user.name", "Helm Pod Replacement Test"]);
    runGit(pvcAuthorityRepoSubPath, ["config", "user.email", "helm-test@example.invalid"]);
    runGit(pvcAuthorityRepoSubPath, ["config", "gc.auto", "0"]);
    runGit(pvcAuthorityRepoSubPath, ["commit", "--allow-empty", "-q", "-m", "init"]);
    mkdirSync(path.join(pvcAuthorityRepoSubPath, "harness"), { recursive: true });
    writeFileSync(
      path.join(pvcAuthorityRepoSubPath, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: center-sqlite\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    writeFileSync(
      path.join(pvcAuthorityRepoSubPath, "harness/people.yaml"),
      `${JSON.stringify(
        {
          schema: "harness-people/v1",
          people: [
            {
              personId: "writer",
              displayName: "writer",
              roles: ["writer"],
              credentials: [
                {
                  kind: "unix-socket-owner-boundary",
                  issuer: `host:${hostname()}`,
                  subject: String(process.getuid?.() ?? 0),
                },
              ],
            },
          ],
          roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }],
        },
        null,
        2,
      )}\n`,
    );
    runGit(pvcAuthorityRepoSubPath, ["add", "harness"]);
    runGit(pvcAuthorityRepoSubPath, ["commit", "-q", "-m", "seed roster"]);

    // Pod 1: boots with PVC user + authority-repo mounts, registers SQLite repo, and writes a canonical fact revision
    const pod1Host = await openDaemonHost({
      daemonId: "center",
      userRoot: pvcUserSubPath,
      requiredStorageBackend: "sqlite",
    });
    let revisionAfterPod1 = 0;
    let recordedFactId = "";
    const localOwnerAuth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary",
      },
    };
    try {
      const reg = await pod1Host.admin(
        { kind: "register", repoId: "center-sqlite", rootDir: pvcAuthorityRepoSubPath, mode: "local" },
        localOwnerAuth,
      );
      assert.equal(reg.ok, true, `Pod 1 register failed: ${JSON.stringify(reg)}`);
      const recorded = await pod1Host.run(
        "center-sqlite",
        {
          kind: "fact-record",
          statement: "StatefulSet PVC authority-repo subPath persists SQLite ledger across Pod replacement.",
          evidenceSource: "test:helm-pod-replacement",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
        },
        localOwnerAuth,
      );
      assert.equal(recorded.outcome, "applied", `Pod 1 fact-record failed: ${JSON.stringify(recorded)}`);
      recordedFactId = String(recorded.factId ?? "");
      assert.ok(recordedFactId.startsWith("F-"), `expected canonical factId, got ${JSON.stringify(recorded)}`);
      const status1 = pod1Host.observabilitySnapshot().repos.find((r) => r.repoId === "center-sqlite");
      assert.ok(status1, "Pod 1 must attach center-sqlite");
      assert.ok(
        typeof status1.ledgerRevision === "number" && status1.ledgerRevision > 0,
        `expected positive ledgerRevision after Pod 1 write, got ${JSON.stringify(status1)}`,
      );
      revisionAfterPod1 = status1.ledgerRevision;
      const ledgerFile = sqliteLedgerPath(pvcAuthorityRepoSubPath);
      assert.equal(
        existsSync(ledgerFile),
        true,
        `SQLite ledger must reside inside PVC authority-repo subPath: ${ledgerFile}`,
      );
    } finally {
      await pod1Host.close();
    }

    // Simulate Pod 1 termination & replacement: delete Pod 1 ephemeral rootfs completely; Pod 2 sees ONLY the PVC subPaths
    rmSync(pod1Ephemeral, { recursive: true, force: true });

    const pod2Host = await openDaemonHost({
      daemonId: "center",
      userRoot: pvcUserSubPath,
      requiredStorageBackend: "sqlite",
    });
    try {
      await pod2Host.attachmentsSettled();
      const status2 = pod2Host.observabilitySnapshot().repos.find((r) => r.repoId === "center-sqlite");
      assert.ok(status2, "Pod 2 must re-attach center-sqlite from persisted PVC registry");
      assert.equal(status2.state, "attached");
      assert.equal(
        status2.ledgerRevision,
        revisionAfterPod1,
        "Pod 2 must read back the exact same SQLite ledgerRevision persisted by Pod 1",
      );
      const readBack = await pod2Host.run(
        "center-sqlite",
        { kind: "fact-show", factId: recordedFactId },
        localOwnerAuth,
      );
      assert.equal(readBack.outcome, "applied", `Pod 2 must read back persisted fact: ${JSON.stringify(readBack)}`);
      assert.match(String(readBack.evidence ?? ""), /StatefulSet PVC authority-repo subPath persists SQLite ledger/u);
    } finally {
      await pod2Host.close();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
