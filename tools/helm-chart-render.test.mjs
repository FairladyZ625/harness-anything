// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const chartRoot = path.join(repoRoot, "deploy/helm/harness-center");

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
    if (!/^[a-z]/u.test(sanitized)) sanitized = `ha-${sanitized}`.replace(/-+$/u, "");
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

test("Real helm lint & helm template verify labels, probes, loopback/stateless/podLabels guards, and StatefulSet upgrade parity (F-G7-41..51)", (t) => {
  const helmBin = process.env.HARNESS_HELM_BIN || "helm";
  const requireHelm = process.env.HARNESS_REQUIRE_HELM_BIN === "1" || process.env.HARNESS_REQUIRE_HELM_BIN === "true";
  const versionProbe = spawnSync(helmBin, ["version", "--short"], { encoding: "utf8" });
  if (versionProbe.error || versionProbe.status !== 0) {
    const reason = `helm binary (${helmBin}) unavailable: ${versionProbe.error?.message ?? versionProbe.stderr?.trim() ?? `exit ${versionProbe.status}`}`;
    if (requireHelm) assert.fail(`HARNESS_REQUIRE_HELM_BIN is set, but ${reason}`);
    t.skip(reason);
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
    const parsedDocs = parseAllDocuments(rendered.stdout);
    for (const doc of parsedDocs) assert.deepEqual(doc.errors, [], `${release}: YAML parse errors`);
    const docs = parsedDocs.map((doc) => doc.toJS()).filter((doc) => doc && typeof doc === "object");
    assert.ok(docs.length >= 6, `expected rendered K8s manifests for release ${release}`);

    const expectedNames = renderHelmNames({ releaseName: release });
    for (const doc of docs) {
      const labels = doc.metadata?.labels ?? {};
      assert.equal(typeof labels["app.kubernetes.io/instance"], "string");
      assert.equal(labels["app.kubernetes.io/instance"], release);
      assert.equal(typeof labels["app.kubernetes.io/name"], "string");
      assert.equal(typeof labels["helm.sh/chart"], "string");
      assert.equal(typeof labels["app.kubernetes.io/managed-by"], "string");
      assert.match(doc.metadata.name, rfc1035, `${release}/${doc.kind}: invalid RFC 1035 name ${doc.metadata.name}`);

      const selector = doc.spec?.selector?.matchLabels ?? doc.spec?.selector ?? doc.spec?.podSelector?.matchLabels;
      if (selector && "app.kubernetes.io/instance" in selector) {
        assert.equal(typeof selector["app.kubernetes.io/instance"], "string");
        assert.equal(selector["app.kubernetes.io/instance"], release);
      }
      if (doc.kind === "Service" && labels["app.kubernetes.io/component"] === "metrics") {
        assert.equal(doc.metadata.name, expectedNames.metricsServiceName);
        assert.ok(doc.metadata.name.startsWith(expectedPrefix));
        assert.equal(seenMetricsServices.has(doc.metadata.name), false);
        seenMetricsServices.add(doc.metadata.name);
      }
    }
  }

  // F-G7-42: StatefulSet long-release upgrade preserves immutable metadata.name, spec.serviceName, and PVC name
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

  // F-G7-48(a): metrics.enabled=false retains startup/readiness/liveness probes + HARNESS_DAEMON_METRICS_EXPOSED=0
  const noMetrics = spawnSync(
    helmBin,
    [
      "template",
      "prod",
      chartRoot,
      "--set",
      "metrics.enabled=false",
      "--set",
      "identity.issuerUrl=https://oidc.example.invalid",
      "--set",
      "identity.existingClientSecret=oidc-secret",
    ],
    { encoding: "utf8" },
  );
  assert.equal(noMetrics.status, 0, `metrics.enabled=false render failed:\n${noMetrics.stderr}`);
  const noMetricsDocs = parseAllDocuments(noMetrics.stdout)
    .map((doc) => doc.toJS())
    .filter((doc) => doc && typeof doc === "object");
  const nmDeploy = noMetricsDocs.find((doc) => doc.kind === "Deployment");
  const nmConfig = noMetricsDocs.find((doc) => doc.kind === "ConfigMap" && doc.data?.HARNESS_DAEMON_ID);
  assert.equal(nmDeploy.spec.template.spec.containers[0].readinessProbe?.httpGet?.path, "/readyz");
  assert.equal(nmDeploy.spec.template.spec.containers[0].livenessProbe?.httpGet?.path, "/healthz");
  assert.equal(nmDeploy.spec.template.spec.containers[0].startupProbe?.httpGet?.path, "/healthz");
  assert.equal(nmDeploy.spec.template.spec.containers[0].readinessProbe?.httpGet?.port, "health");
  assert.equal(nmConfig.data.HARNESS_DAEMON_METRICS_EXPOSED, "0");
  assert.equal(nmConfig.data.HARNESS_DAEMON_REQUIRE_IDENTITY, "1");
  assert.equal(
    noMetricsDocs.some(
      (doc) => doc.kind === "Service" && doc.metadata?.labels?.["app.kubernetes.io/component"] === "metrics",
    ),
    false,
  );

  // F-G7-48(b/c) & F-G7-49: reject loopback bind, stateless without identity, and conflicting podLabels/annotations
  for (const badArgs of [
    ["--set-string", "metrics.bind=127.0.0.1"],
    ["--set-string", "metrics.bind=::1"],
    ["--set-string", "metrics.bind=localhost"],
    ["--set", "persistence.enabled=false", "--set", "fleet.enabled=false"],
    ["--set", "metrics.enabled=false", "--set", "fleet.port=9090"],
    ["--set-string", "podLabels.app\\.kubernetes\\.io/name=custom"],
    ["--set-string", "podLabels.app\\.kubernetes\\.io/instance=custom"],
    ["--set-string", "podAnnotations.checksum/config=override"],
    ["--set-string", "metrics.serviceMonitor.labels.app\\.kubernetes\\.io/name=custom"],
    ["--set-string", "metrics.prometheusRule.labels.helm\\.sh/chart=custom"],
  ]) {
    const failed = spawnSync(helmBin, ["template", "prod", chartRoot, ...badArgs], { encoding: "utf8" });
    assert.notEqual(failed.status, 0, `helm template must reject ${badArgs.join(" ")}`);
  }

  // Valid stateless PostgreSQL Deployment with complete external OIDC + custom non-reserved podLabels
  const cleanCustom = spawnSync(
    helmBin,
    [
      "template",
      "prod",
      chartRoot,
      "--set",
      "persistence.enabled=false",
      "--set",
      "fleet.enabled=false",
      "--set",
      "identity.issuerUrl=https://oidc.example.invalid",
      "--set",
      "identity.existingClientSecret=oidc-secret",
      "--set-string",
      "podLabels.team=platform",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cleanCustom.status, 0, `valid stateless+podLabels render failed:\n${cleanCustom.stderr}`);
  const parsedCustomDocs = parseAllDocuments(cleanCustom.stdout);
  for (const doc of parsedCustomDocs) {
    assert.deepEqual(doc.errors, [], `YAML parse errors: ${JSON.stringify(doc.errors)}`);
  }
  const customDeploy = parsedCustomDocs.map((d) => d.toJS()).find((d) => d?.kind === "Deployment");
  const customConfig = parsedCustomDocs
    .map((d) => d.toJS())
    .find((d) => d?.kind === "ConfigMap" && d?.data?.HARNESS_DAEMON_ID);
  assert.equal(customDeploy.spec.template.metadata.labels.team, "platform");
  assert.equal(customDeploy.spec.template.metadata.labels["app.kubernetes.io/name"], "harness-center");
  assert.equal(customDeploy.spec.template.metadata.labels["app.kubernetes.io/instance"], "prod");
  assert.equal(customConfig.data.HARNESS_DAEMON_REQUIRE_IDENTITY, "1");
});
