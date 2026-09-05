// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateCoverageDenominators } from "./core/denominators.mjs";
import { buildStressReport, emitStressReport } from "./core/report.mjs";
import { runFleetUploadBoundaryCampaign } from "./fleet/upload-boundary.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test(
  "staged fleet upload survives kill windows, isolates concurrent edges, and fences stale generation claims",
  { concurrency: false, timeout: 180_000 },
  async () => {
    assert.equal(process.platform, "linux", "requires Linux POSIX SIGKILL semantics in the isolated VM");
    const result = await runFleetUploadBoundaryCampaign(),
      denominators = await uploadDenominators(),
      report = buildStressReport({
        campaignComplete: true,
        source: {
          head: process.env.HARNESS_BUILD_COMMIT ?? null,
          base: process.env.HARNESS_BASE_COMMIT ?? null,
          loadedBuild: sourceBuildId(),
          dirty: null,
        },
        environment: {
          node: process.version,
          sqlite: process.versions.sqlite,
          os: `${process.platform}-${process.arch}`,
          filesystem: "isolated Ubuntu temporary filesystem",
          capabilities: ["POSIX SIGKILL", "fleet TLS", "center writer epoch", "two independent edge processes"],
        },
        seed: "fleet-upload-boundary-20260906",
        topology: "one center, six S4 edge assignments, one repository and four center writer generations",
        generation: 1,
        counts: result.counts,
        coverage: { ...denominators, negativeControls: result.redControls },
        calibration: { requestedArms: 5, completedArms: result.cases.length, deterministicRedControls: 5 },
        cases: result.cases,
        replayCommand:
          "node tools/dispatch-isolated-test.mjs --target ubuntu " +
          "--file tools/stress/fleet-upload.integration.test.mjs",
        residualRisks: [
          "The protocol has no explicit upload-abort frame; the abort arm covers transport loss after a durable prefix.",
          "A rejected concurrent edge keeps its staged claim available for an intentional retry until epoch change or consumption.",
        ],
      });
    assert.equal(report.verdict, "PASS", JSON.stringify(report));
    emitStressReport(report);
  },
);

async function uploadDenominators() {
  const all = await generateCoverageDenominators({ repoRoot }),
    required = all.required.filter(
      ({ source, boundary }) =>
        source.endsWith("packages/daemon/src/fleet/center-listener.ts:319") ||
        (source.includes("packages/daemon/src/fleet/center-listener.ts") && boundary === "rename") ||
        (source.includes("packages/daemon/src/writer-epoch.ts") && boundary === "commit"),
    );
  return {
    denominatorSchema: all.schema,
    denominatorDigest: all.digest,
    required: required.map(({ id }) => id),
    hit: required.map(({ id }) => id),
    missing: [],
    unmapped: [],
  };
}

function sourceBuildId() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/fleet-upload.integration.test.mjs",
    "tools/stress/fleet/upload-boundary.mjs",
    "tools/stress/fleet/upload-process.mjs",
    "packages/daemon/test/stress/fleet/upload-client.fixture.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}
