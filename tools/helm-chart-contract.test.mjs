// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { PROMETHEUS_METRIC_NAMES } from "../packages/kernel/src/domain/prometheus-metrics.ts";

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

function renderHelmNames({
  releaseName,
  chartName = "harness-center",
  nameOverride = "",
  fullnameOverride = "",
  headlessNameOverride = "",
}) {
  const trunc = (value, maxLen) => value.slice(0, maxLen).replace(/-+$/u, "");
  const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const name = trunc(nameOverride || chartName, 63);
  let fullname;
  if (fullnameOverride) {
    fullname = trunc(fullnameOverride, 63);
  } else {
    let sanitized = `${releaseName}-${name}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    if (!/^[a-z]/u.test(sanitized)) {
      sanitized = `ha-${sanitized}`.replace(/-+$/u, "");
    }
    fullname = `${trunc(sanitized, 35)}-${sha16(releaseName)}`;
  }
  const derived = (suffix, directMax, hashPrefixMax) =>
    fullname.length <= directMax
      ? `${fullname}-${suffix}`
      : `${trunc(fullname, hashPrefixMax)}-${sha16(fullname)}-${suffix}`;
  return {
    fullname,
    fleetServiceName: derived("fleet", 57, 40),
    metricsServiceName: derived("metrics", 55, 38),
    headlessServiceName: headlessNameOverride ? trunc(headlessNameOverride, 63) : derived("headless", 54, 37),
    entrypointConfigMapName: derived("entrypoint", 52, 35),
  };
}

function validateHelmValuesRender(values) {
  const errors = [];
  if (Number(values.replicaCount) !== 1) errors.push("replicaCount must equal 1");
  if (values.fullnameOverride && !/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(values.fullnameOverride)) {
    errors.push("fullnameOverride must be a valid RFC 1035 DNS label");
  }
  if (
    values.service?.headlessNameOverride &&
    !/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(values.service.headlessNameOverride)
  ) {
    errors.push("service.headlessNameOverride must be a valid RFC 1035 DNS label");
  }
  if (values.workloadKind === "StatefulSet" && values.service?.headlessNameOverride) {
    const names = renderHelmNames({
      releaseName: "release",
      fullnameOverride: values.fullnameOverride ?? "",
      headlessNameOverride: values.service.headlessNameOverride,
    });
    if (values.fleet?.enabled && names.headlessServiceName === names.fleetServiceName) {
      errors.push("service.headlessNameOverride collides with Fleet Service name");
    }
    if (values.metrics?.enabled && names.headlessServiceName === names.metricsServiceName) {
      errors.push("service.headlessNameOverride collides with Metrics Service name");
    }
  }
  if (values.storage?.backend === "postgres" && !values.storage?.existingSecret) {
    errors.push("storage.existingSecret is required when storage.backend=postgres");
  }
  if (values.storage?.backend === "sqlite" && values.workloadKind === "Deployment" && !values.persistence?.enabled) {
    errors.push("storage.backend=sqlite requires workloadKind=StatefulSet or persistence.enabled=true");
  }
  if (values.fleet?.enabled && values.workloadKind === "Deployment" && !values.persistence?.enabled) {
    errors.push("fleet.enabled=true requires workloadKind=StatefulSet or persistence.enabled=true");
  }
  if (values.identity?.mode === "managed" && values.workloadKind === "Deployment" && !values.persistence?.enabled) {
    errors.push("identity.mode=managed requires workloadKind=StatefulSet or persistence.enabled=true");
  }
  if (values.fleet?.enabled) {
    if (values.fleet.authorityRepoId && !values.fleet.tlsExistingSecret) {
      errors.push("fleet.tlsExistingSecret is required when fleet.authorityRepoId is set");
    }
    if (values.fleet.tlsExistingSecret && !values.fleet.authorityRepoId) {
      errors.push("fleet.authorityRepoId is required when fleet.tlsExistingSecret is set");
    }
  }
  if (values.identity?.mode === "external") {
    if (values.identity.issuerUrl && !values.identity.existingClientSecret) {
      errors.push("identity.existingClientSecret is required when identity.issuerUrl is set");
    }
    if (values.identity.existingClientSecret && !values.identity.issuerUrl) {
      errors.push("identity.issuerUrl is required when identity.existingClientSecret is set");
    }
  }
  if (values.fleet?.enabled && values.metrics?.enabled && Number(values.fleet.port) === Number(values.metrics.port)) {
    errors.push("fleet.port and metrics.port must be distinct when both fleet.enabled and metrics.enabled are true");
  }
  const userRootClean = path.posix.normalize(String(values.daemon?.userRoot ?? "")).replace(/\/+$/u, "") || "/";
  const repoRootClean = path.posix.normalize(String(values.fleet?.authorityRepoRoot ?? "")).replace(/\/+$/u, "") || "/";
  if (
    values.fleet?.enabled &&
    (userRootClean === repoRootClean ||
      repoRootClean.startsWith(`${userRootClean}/`) ||
      userRootClean.startsWith(`${repoRootClean}/`))
  ) {
    errors.push("fleet.authorityRepoRoot and daemon.userRoot must be disjoint normalized absolute paths");
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

  // F-G7-35: Fleet-enabled Deployment requires persistence.enabled=true; stateless Deployment is allowed only when fleet.enabled=false and backend=postgres
  assert.equal(values.persistence.enabled, true, "default values.yaml with fleet.enabled=true must enable persistence");
  assert.equal(
    validate({
      ...values,
      workloadKind: "Deployment",
      fleet: { ...values.fleet, enabled: true },
      persistence: { ...values.persistence, enabled: false },
    }),
    false,
    "schema must reject unpersisted Deployment when fleet.enabled=true",
  );
  assert.equal(
    validate({
      ...values,
      workloadKind: "Deployment",
      fleet: { ...values.fleet, enabled: false },
      persistence: { ...values.persistence, enabled: false },
    }),
    true,
    "schema must allow stateless Deployment when storage.backend=postgres and fleet.enabled=false",
  );

  // F-G7-37: fullnameOverride must be a strict RFC 1035 DNS label when set
  for (const badOverride of ["7center", "team.prod", "UPPER", "-leading", "trailing-", "a".repeat(64)]) {
    assert.equal(
      validate({ ...values, fullnameOverride: badOverride }),
      false,
      `schema must reject non-RFC-1035 fullnameOverride=${badOverride}`,
    );
  }
  assert.equal(validate({ ...values, fullnameOverride: "legacy-center-01" }), true);

  // F-G7-38: paired Fleet (authorityRepoId <-> tlsExistingSecret), paired external OIDC (issuerUrl <-> existingClientSecret),
  // and clean normalized absolute mount paths
  assert.equal(
    validate({
      ...values,
      fleet: { ...values.fleet, enabled: true, authorityRepoId: "org-center", tlsExistingSecret: "" },
    }),
    false,
    "schema must reject fleet.authorityRepoId without fleet.tlsExistingSecret",
  );
  assert.equal(
    validate({
      ...values,
      fleet: { ...values.fleet, enabled: true, authorityRepoId: "", tlsExistingSecret: "fleet-tls" },
    }),
    false,
    "schema must reject fleet.tlsExistingSecret without fleet.authorityRepoId",
  );
  assert.equal(
    validate({
      ...values,
      fleet: { ...values.fleet, enabled: true, authorityRepoId: "org-center", tlsExistingSecret: "fleet-tls" },
    }),
    true,
    "schema must accept paired fleet.authorityRepoId + fleet.tlsExistingSecret",
  );
  assert.equal(
    validate({
      ...values,
      identity: {
        ...values.identity,
        mode: "external",
        issuerUrl: "https://idp.example.org",
        existingClientSecret: "",
      },
    }),
    false,
    "schema must reject external identity.issuerUrl without existingClientSecret",
  );
  assert.equal(
    validate({
      ...values,
      identity: { ...values.identity, mode: "external", issuerUrl: "", existingClientSecret: "oidc-secret" },
    }),
    false,
    "schema must reject external identity.existingClientSecret without issuerUrl",
  );
  assert.equal(
    validate({
      ...values,
      identity: {
        ...values.identity,
        mode: "external",
        issuerUrl: "https://idp.example.org",
        existingClientSecret: "oidc-secret",
      },
    }),
    true,
    "schema must accept paired external identity.issuerUrl + existingClientSecret",
  );
  for (const dirtyRoot of [
    "/var/lib/ha/user/../user",
    "/var/lib/ha/./user",
    "/var/lib/ha//user",
    "/var/lib/ha/user/",
  ]) {
    assert.equal(
      validate({ ...values, fleet: { ...values.fleet, authorityRepoRoot: dirtyRoot } }),
      false,
      `schema must reject unnormalized authorityRepoRoot=${dirtyRoot}`,
    );
    assert.equal(
      validate({ ...values, daemon: { ...values.daemon, userRoot: dirtyRoot } }),
      false,
      `schema must reject unnormalized daemon.userRoot=${dirtyRoot}`,
    );
  }

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

  // F-G7-18, F-G7-28, F-G7-37, F-G7-41 & F-G7-42: RFC 1035 DNS-label release-unique base (64-bit sha256),
  // exact Sprig regexReplaceAll(regex, s, repl) argument order (never piped!), string-quoted labels/selectors,
  // and explicit service.headlessNameOverride for immutable StatefulSet spec.serviceName upgrades.
  assert.ok(helpers.includes('define "harness-center.fleetServiceName"'));
  assert.ok(helpers.includes('define "harness-center.entrypointConfigMapName"'));
  assert.ok(helpers.includes(".Release.Name | sha256sum | trunc 16"));
  assert.ok(
    helpers.includes('regexReplaceAll "[^a-z0-9-]+" $raw "-"'),
    "_helpers.tpl must pass $raw as the 2nd argument to Sprig regexReplaceAll (never pipe input as 3rd repl argument)",
  );
  assert.ok(
    !/\|\s*regexReplaceAll\b/u.test(helpers),
    "_helpers.tpl must never pipe a value into Sprig regexReplaceAll (Go pipelines append input as the replacement string)",
  );
  assert.ok(helpers.includes('helm.sh/chart: {{ include "harness-center.chart" . | quote }}'));
  assert.ok(helpers.includes("app.kubernetes.io/managed-by: {{ .Release.Service | quote }}"));
  assert.ok(helpers.includes('app.kubernetes.io/name: {{ include "harness-center.name" . | quote }}'));
  assert.ok(helpers.includes("app.kubernetes.io/instance: {{ .Release.Name | quote }}"));
  assert.ok(helpers.includes('regexMatch "^[a-z]"'));
  assert.ok(helpers.includes(".Values.service.headlessNameOverride"));
  assert.ok(helpers.includes("trunc 40") && helpers.includes("trunc 38") && helpers.includes("sha256sum | trunc 16"));
  assert.ok(helpers.includes("trunc 37") && helpers.includes("trunc 35"));
  assert.ok(fleetService.includes('name: {{ include "harness-center.fleetServiceName" . }}'));
  assert.ok(deployment.includes('name: {{ include "harness-center.entrypointConfigMapName" . }}'));
  assert.ok(statefulset.includes('name: {{ include "harness-center.entrypointConfigMapName" . }}'));

  // F-G7-41: Verify label & selector YAML types render strictly as strings for numeric/boolean Helm release names (0, 42, true)
  const selectorBlock = /\{\{-\s*define "harness-center\.selectorLabels"\s*-\}\}([\s\S]*?)\{\{-\s*end\s*\}\}/u.exec(
    helpers,
  )?.[1];
  const labelsBlock = /\{\{-\s*define "harness-center\.labels"\s*-\}\}([\s\S]*?)\{\{-\s*end\s*\}\}/u.exec(helpers)?.[1];
  assert.ok(selectorBlock && labelsBlock, "_helpers.tpl must define selectorLabels and labels");
  for (const scalarRelease of ["0", "42", "true", "prod", "team.prod", "7center"]) {
    const renderedSelectors = selectorBlock
      .replace(/\{\{\s*include "harness-center\.name" \.\s*\|\s*quote\s*\}\}/gu, JSON.stringify("harness-center"))
      .replace(/\{\{\s*\.Release\.Name\s*\|\s*quote\s*\}\}/gu, JSON.stringify(scalarRelease));
    assert.ok(
      !renderedSelectors.includes("{{"),
      `selectorLabels template must quote every dynamic label value (unrendered: ${renderedSelectors})`,
    );
    const parsedSelectors = parseYaml(renderedSelectors);
    assert.equal(typeof parsedSelectors["app.kubernetes.io/name"], "string");
    assert.equal(typeof parsedSelectors["app.kubernetes.io/instance"], "string");
    assert.equal(parsedSelectors["app.kubernetes.io/instance"], scalarRelease);
  }

  // F-G7-42 & F-G7-43: service.headlessNameOverride validation & collision check, plus managed identity persistence guard
  const ajvValidator = new Ajv({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync(path.join(chartRoot, "values.schema.json"), "utf8")),
  );
  const legacyHeadless = `${"a".repeat(45)}-47c7f801-headless`;
  assert.equal(
    ajvValidator({
      ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")),
      workloadKind: "StatefulSet",
      fullnameOverride: `${"a".repeat(53)}-harness-c`,
      service: {
        ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")).service,
        headlessNameOverride: legacyHeadless,
      },
    }),
    true,
    "valid RFC 1035 service.headlessNameOverride must pass schema validation",
  );
  assert.equal(
    ajvValidator({
      ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")),
      service: {
        ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")).service,
        headlessNameOverride: "7invalid.headless",
      },
    }),
    false,
    "non-RFC-1035 service.headlessNameOverride must fail schema validation",
  );
  assert.equal(
    ajvValidator({
      ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")),
      workloadKind: "Deployment",
      storage: { backend: "postgres", existingSecret: "pg-secret", secretKey: "daemon-storage.json" },
      fleet: { ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")).fleet, enabled: false },
      identity: {
        ...parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8")).identity,
        mode: "managed",
      },
      persistence: { enabled: false, storageClass: "", accessModes: ["ReadWriteOnce"], size: "10Gi" },
    }),
    false,
    "identity.mode=managed with Deployment and persistence.enabled=false must fail schema validation",
  );
  const baseDefaults = parseYaml(readFileSync(path.join(chartRoot, "values.yaml"), "utf8"));
  assert.ok(
    validateHelmValuesRender({
      ...baseDefaults,
      workloadKind: "StatefulSet",
      fullnameOverride: "prod-center",
      service: { ...baseDefaults.service, headlessNameOverride: "prod-center-fleet" },
    }).some((entry) => entry.includes("collides with Fleet Service")),
  );
  assert.ok(
    validateHelmValuesRender({
      ...baseDefaults,
      workloadKind: "StatefulSet",
      fullnameOverride: "prod-center",
      service: { ...baseDefaults.service, headlessNameOverride: "prod-center-metrics" },
    }).some((entry) => entry.includes("collides with Metrics Service")),
  );
  assert.ok(
    validateHelmValuesRender({
      ...baseDefaults,
      workloadKind: "Deployment",
      fleet: { ...baseDefaults.fleet, enabled: false },
      identity: { ...baseDefaults.identity, mode: "managed" },
      persistence: { ...baseDefaults.persistence, enabled: false },
    }).some((entry) => entry.includes("identity.mode=managed requires")),
  );

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

  // F-G7-29, F-G7-35, F-G7-38 & F-G7-40: StatefulSet and Deployment mount daemon-state PVC root at daemon.userRoot
  // (preserving pre-release PVC upgrades) and subPath: authority-repo at fleet.authorityRepoRoot; require persistence for sqlite and Fleet;
  // enforce paired Fleet/OIDC config and POSIX-normalized disjoint mount paths.
  assert.ok(
    helpers.includes('eq .Values.storage.backend "sqlite"') && helpers.includes("not .Values.persistence.enabled"),
  );
  assert.ok(
    helpers.includes('.Values.fleet.enabled (eq .Values.workloadKind "Deployment") (not .Values.persistence.enabled)'),
  );
  assert.ok(
    helpers.includes("clean .Values.daemon.userRoot") && helpers.includes("clean .Values.fleet.authorityRepoRoot"),
  );
  assert.ok(
    helpers.includes("fleet.tlsExistingSecret is required") &&
      helpers.includes("identity.existingClientSecret is required"),
  );
  assert.ok(
    !statefulset.includes("subPath: user"),
    "StatefulSet must mount daemon.userRoot at PVC root (no subPath: user)",
  );
  assert.ok(statefulset.includes("subPath: authority-repo"));
  assert.ok(statefulset.includes("mountPath: {{ .Values.fleet.authorityRepoRoot | quote }}"));
  assert.ok(
    !deployment.includes("subPath: user"),
    "Deployment must mount daemon.userRoot at PVC root (no subPath: user)",
  );
  assert.ok(deployment.includes("subPath: authority-repo"));
  assert.ok(deployment.includes("mountPath: {{ .Values.fleet.authorityRepoRoot | quote }}"));

  for (const overlappingRepoRoot of [
    defaultValues.daemon.userRoot,
    `${defaultValues.daemon.userRoot}/../user`,
    `${defaultValues.daemon.userRoot}/sub`,
    path.posix.dirname(defaultValues.daemon.userRoot),
  ]) {
    const mountErrors = validateHelmValuesRender({
      ...defaultValues,
      fleet: { ...defaultValues.fleet, authorityRepoRoot: overlappingRepoRoot },
    });
    assert.ok(
      mountErrors.some((entry) => entry.includes("disjoint normalized absolute paths")),
      `render validation must reject overlapping/nested authorityRepoRoot=${overlappingRepoRoot}`,
    );
  }
  assert.ok(
    validateHelmValuesRender({
      ...defaultValues,
      fleet: { ...defaultValues.fleet, authorityRepoId: "org-center", tlsExistingSecret: "" },
    }).some((entry) => entry.includes("fleet.tlsExistingSecret")),
  );
  assert.ok(
    validateHelmValuesRender({
      ...defaultValues,
      identity: {
        ...defaultValues.identity,
        mode: "external",
        issuerUrl: "https://idp.example.org",
        existingClientSecret: "",
      },
    }).some((entry) => entry.includes("identity.existingClientSecret")),
  );
  assert.ok(
    validateHelmValuesRender({
      ...defaultValues,
      workloadKind: "Deployment",
      fleet: { ...defaultValues.fleet, enabled: true },
      persistence: { ...defaultValues.persistence, enabled: false },
    }).some((entry) => entry.includes("fleet.enabled=true requires")),
  );

  // Strict RFC 1035 DNS label pattern required by Kubernetes Services: MUST start with [a-z], no dots, <= 63 chars
  const rfc1035DnsLabelPattern = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  const namingCases = [
    { label: "prod", releaseName: "prod" },
    { label: "team.prod", releaseName: "team.prod" },
    { label: "team-prod", releaseName: "team-prod" },
    { label: "7center", releaseName: "7center" },
    { label: "0", releaseName: "0" },
    { label: "a.b.c.d", releaseName: "a.b.c.d" },
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
        candidate.length <= 63 && rfc1035DnsLabelPattern.test(candidate),
        `${namingCase.label}: invalid RFC 1035 K8s Service DNS label ${candidate} (len=${candidate.length})`,
      );
    }
    assert.equal(
      new Set(allNames).size,
      5,
      `${namingCase.label}: base, Fleet, metrics, headless Services and entrypoint ConfigMap must never collide: ${JSON.stringify(names)}`,
    );
  }
  // F-G7-28 & F-G7-37: ALL default releases installed in the same namespace (including dotted & digit-leading) produce zero collisions!
  const defaultReleaseLabels = [
    "prod",
    "team.prod",
    "team-prod",
    "7center",
    "0",
    "a.b.c.d",
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

test("Real helm lint & helm template verify string-quoted labels, Sprig naming prefixes, and StatefulSet spec.serviceName preservation when helm CLI is installed (F-G7-41, F-G7-42)", () => {
  const helmBin = process.env.HARNESS_HELM_BIN || "helm";
  const versionProbe = spawnSync(helmBin, ["version", "--short"], { encoding: "utf8" });
  if (versionProbe.error || versionProbe.status !== 0) {
    // When running in minimal environments without the external helm binary, the template & schema tests above still run.
    return;
  }

  const lint = spawnSync(helmBin, ["lint", chartRoot], { encoding: "utf8" });
  assert.equal(lint.status, 0, `helm lint failed:\n${lint.stdout}\n${lint.stderr}`);

  const rfc1035 = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  const cases = [
    { release: "prod", expectedPrefix: "prod-harness-center-" },
    { release: "team.prod", expectedPrefix: "team-prod-harness-center-" },
    { release: "team-prod", expectedPrefix: "team-prod-harness-center-" },
    { release: "7center", expectedPrefix: "ha-7center-harness-center-" },
    { release: "0", expectedPrefix: "ha-0-harness-center-" },
    { release: "42", expectedPrefix: "ha-42-harness-center-" },
    { release: "true", expectedPrefix: "true-harness-center-" },
  ];
  const seenMetricsServices = new Set();

  for (const { release, expectedPrefix } of cases) {
    const rendered = spawnSync(
      helmBin,
      [
        "template",
        release,
        chartRoot,
        "--set",
        "metrics.serviceMonitor.enabled=true",
        "--set",
        "metrics.prometheusRule.enabled=true",
        "--set",
        "podDisruptionBudget.enabled=true",
        "--set",
        "networkPolicy.enabled=true",
      ],
      { encoding: "utf8" },
    );
    assert.equal(rendered.status, 0, `helm template ${release} failed:\n${rendered.stderr}`);
    const docs = parseAllDocuments(rendered.stdout)
      .map((doc) => doc.toJS())
      .filter((doc) => doc && typeof doc === "object");
    assert.ok(docs.length >= 6, `expected rendered K8s manifests for release ${release}`);

    const expectedNames = renderHelmNames({ releaseName: release });
    for (const doc of docs) {
      const labels = doc.metadata?.labels ?? {};
      assert.equal(
        typeof labels["app.kubernetes.io/instance"],
        "string",
        `${release}/${doc.kind}: app.kubernetes.io/instance label must be a YAML string`,
      );
      assert.equal(labels["app.kubernetes.io/instance"], release);
      assert.equal(typeof labels["app.kubernetes.io/name"], "string");
      assert.equal(typeof labels["helm.sh/chart"], "string");
      assert.equal(typeof labels["app.kubernetes.io/managed-by"], "string");
      assert.match(doc.metadata.name, rfc1035, `${release}/${doc.kind}: invalid RFC 1035 name ${doc.metadata.name}`);

      const selector = doc.spec?.selector?.matchLabels ?? doc.spec?.selector ?? doc.spec?.podSelector?.matchLabels;
      if (selector && "app.kubernetes.io/instance" in selector) {
        assert.equal(
          typeof selector["app.kubernetes.io/instance"],
          "string",
          `${release}/${doc.kind}: selector app.kubernetes.io/instance must be a YAML string`,
        );
        assert.equal(selector["app.kubernetes.io/instance"], release);
      }
      if (doc.kind === "Service" && labels["app.kubernetes.io/component"] === "metrics") {
        assert.equal(doc.metadata.name, expectedNames.metricsServiceName);
        assert.ok(
          doc.metadata.name.startsWith(expectedPrefix),
          `${release}: metrics Service ${doc.metadata.name} must preserve readable prefix ${expectedPrefix}`,
        );
        assert.equal(seenMetricsServices.has(doc.metadata.name), false, `collision on ${doc.metadata.name}`);
        seenMetricsServices.add(doc.metadata.name);
      }
    }
  }

  // F-G7-42: Verify StatefulSet long-release upgrade preserves immutable metadata.name, spec.serviceName, and PVC name
  const longRelease = "a".repeat(53);
  const legacyWorkloadName = `${"a".repeat(53)}-harness-c`;
  const legacyServiceName = `${"a".repeat(45)}-47c7f801-headless`;
  const stsRender = spawnSync(
    helmBin,
    [
      "template",
      longRelease,
      chartRoot,
      "--set",
      "workloadKind=StatefulSet",
      "--set-string",
      `fullnameOverride=${legacyWorkloadName}`,
      "--set-string",
      `service.headlessNameOverride=${legacyServiceName}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(stsRender.status, 0, `StatefulSet upgrade render failed:\n${stsRender.stderr}`);
  const stsDocs = parseAllDocuments(stsRender.stdout)
    .map((doc) => doc.toJS())
    .filter((doc) => doc && typeof doc === "object");
  const sts = stsDocs.find((doc) => doc.kind === "StatefulSet");
  const headlessSvc = stsDocs.find(
    (doc) => doc.kind === "Service" && doc.metadata?.labels?.["app.kubernetes.io/component"] === "headless",
  );
  assert.ok(sts && headlessSvc, "StatefulSet and headless Service must render");
  assert.equal(sts.metadata.name, legacyWorkloadName);
  assert.equal(sts.spec.serviceName, legacyServiceName);
  assert.equal(headlessSvc.metadata.name, legacyServiceName);
  assert.equal(sts.spec.volumeClaimTemplates?.[0]?.metadata?.name, "daemon-state");
});
