// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { PROMETHEUS_METRIC_NAMES } from "../packages/kernel/src/domain/prometheus-metrics.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const chartRoot = path.join(repoRoot, "deploy/helm/harness-center");
const templatesRoot = path.join(chartRoot, "templates");

const REQUIRED_TEMPLATES = [
  "_helpers.tpl",
  "configmap.yaml",
  "deployment.yaml",
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
  assert.equal(values.podSecurityContext.runAsNonRoot, true);
  assert.equal(values.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(values.securityContext.capabilities.drop, ["ALL"]);
});

test("Helm templates provide stateless/stateful separation, probes, secrets separation, and balanced syntax", () => {
  for (const name of REQUIRED_TEMPLATES) {
    const filePath = path.join(templatesRoot, name);
    assert.ok(existsSync(filePath), `missing required template: ${name}`);
    const content = readFileSync(filePath, "utf8");
    assertBalancedHelmDirectives(name, content);
  }

  const deployment = readFileSync(path.join(templatesRoot, "deployment.yaml"), "utf8");
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  const service = readFileSync(path.join(templatesRoot, "service.yaml"), "utf8");
  const serviceMonitor = readFileSync(path.join(templatesRoot, "servicemonitor.yaml"), "utf8");
  const prometheusRule = readFileSync(path.join(templatesRoot, "prometheusrule.yaml"), "utf8");

  // Stateless vs Stateful separation
  assert.ok(deployment.includes('eq .Values.workloadKind "Deployment"'));
  assert.ok(deployment.includes("kind: Deployment"));
  assert.ok(statefulset.includes('eq .Values.workloadKind "StatefulSet"'));
  assert.ok(statefulset.includes("kind: StatefulSet"));
  assert.ok(statefulset.includes("volumeClaimTemplates:"));

  // Both workloads wire liveness/readiness probes and external PG/OIDC Secret mounts
  for (const [label, body] of [
    ["deployment.yaml", deployment],
    ["statefulset.yaml", statefulset],
  ]) {
    assert.ok(body.includes("/healthz"), `${label} must probe /healthz`);
    assert.ok(body.includes("/readyz"), `${label} must probe /readyz`);
    assert.ok(body.includes("daemon-storage.json"), `${label} must mount PostgreSQL daemon-storage.json Secret`);
    assert.ok(body.includes("HARNESS_DAEMON_METRICS_PORT"), `${label} must configure metrics port env`);
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
