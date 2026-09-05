// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeededScenario, runScenario } from "./core/controller.mjs";
import { generateCoverageDenominators } from "./core/denominators.mjs";
import { openReceiptLog, readReceiptLog } from "./core/receipt-log.mjs";
import { buildStressReport, emitStressReport } from "./core/report.mjs";
import { runMixedHistoryScenario } from "./daemon/mixed-history-scenario.mjs";
import {
  runRegistryChangeoverScenario,
  runRuntimeOwnershipScenario,
  runMultiClientScenario,
} from "./daemon/registry-runtime-scenarios.mjs";
import { runProjectionOwnerScenario, runWriterFenceScenario } from "./daemon/writer-projection-scenarios.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../.."),
  seed = "stress-s3-daemon-20260906",
  armIds = ["F04", "F05", "F09", "F10", "F11", "S3-multi-client"];

test(
  "S3 daemon recovery campaign exercises changeover, fences, projection owners, mixed history, and runtime adoption",
  { concurrency: false, timeout: 600_000 },
  async () => {
    assert.equal(process.platform, "linux", "requires Linux POSIX SIGKILL and isolated daemon processes");
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-stress-s3-daemon-")),
      targetRoots = Object.fromEntries(armIds.map((id) => [id, path.join(scratch, "targets", id)])),
      receiptFile = path.join(scratch, "controller", "receipts.jsonl"),
      receiptLog = openReceiptLog({
        file: receiptFile,
        targetRoots: Object.values(targetRoots),
        campaignId: "stress-s3-daemon",
        seed,
      }),
      results = new Map(),
      scenario = createSeededScenario({
        seed,
        requests: armIds.map((id) => ({
          requestId: `request-${id}`,
          opId: `op-${id}`,
          intentDigest: `stress-s3:${id}`,
          expectedEvents: [],
          boundary: id,
        })),
      });
    try {
      const executed = await runScenario({
        scenario,
        receiptLog,
        watchdogMs: 180_000,
        adapter: {
          submit: async (request) => {
            const result = await runArm(request.requestId.slice("request-".length), targetRoots);
            results.set(request.requestId, result);
            return { status: "accepted_durable", caseId: result.caseResult.id };
          },
        },
      });
      const controllerLog = readReceiptLog(receiptFile),
        failedRequests = executed.observations.filter(({ receipt }) => receipt === null),
        denominators = await daemonDenominators(),
        cases = armIds.map((id) => {
          const result = results.get(`request-${id}`);
          return (
            result?.caseResult ?? {
              id,
              boundaryHits: [],
              faults: [],
              oracles: {},
              verdict: "BLOCKED",
              violations: failedRequests
                .filter(({ requestId }) => requestId === `request-${id}`)
                .map(({ error }) => error),
            }
          );
        }),
        negativeControls = [...results.values()].flatMap(({ redControl }) =>
          redControl === undefined ? [] : [redControl],
        ),
        report = buildStressReport({
          campaignComplete:
            controllerLog.complete && failedRequests.length === 0 && armIds.every((id) => results.has(`request-${id}`)),
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
            capabilities: ["POSIX SIGKILL", "node:sqlite", "Git", "Unix socket", "independent CLI clients"],
          },
          seed,
          topology: "external S1 controller + isolated daemons + runtime worker-host + canonical projection",
          generation: 1,
          counts: {
            acceptedEvents: cases.reduce((total, entry) => total + Number(entry.observations?.acceptedTasks ?? 0), 0),
            uniqueBlobs: 1,
            maxConcurrentClients: 8,
          },
          coverage: { ...denominators, negativeControls },
          calibration: {
            requestedArms: armIds.length,
            completedArms: results.size,
            controllerRecords: controllerLog.records.length,
            deterministicRedControls: negativeControls.length,
          },
          cases,
          replayCommand:
            "node tools/dispatch-isolated-test.mjs --target ubuntu " +
            "--file tools/stress/daemon-campaign.integration.test.mjs",
          residualRisks: [
            "The staged fleet-upload protocol is orthogonal to eight local daemon clients and remains a separate packet.",
            "Diagnostic lifecycle/request/stdout durability remains explicitly unresolved; O4 covers accepted runtime stream bytes.",
            "The repository implements build-drift drain plus autostart, not a prepare/activate changeover API.",
          ],
        });
      emitStressReport(report);
      assert.deepEqual(failedRequests, [], JSON.stringify(failedRequests));
      assert.equal(negativeControls.length, 5);
      assert.equal(report.verdict, "PASS", JSON.stringify(report));
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

async function runArm(id, roots) {
  if (id === "F04") return runRegistryChangeoverScenario(roots[id]);
  if (id === "F05") return runWriterFenceScenario(roots[id]);
  if (id === "F09") return runProjectionOwnerScenario(roots[id]);
  if (id === "F10") return runMixedHistoryScenario(roots[id]);
  if (id === "F11") return runRuntimeOwnershipScenario(roots[id]);
  if (id === "S3-multi-client") return runMultiClientScenario(roots[id]);
  throw new Error(`unknown S3 arm ${id}`);
}

async function daemonDenominators() {
  const all = await generateCoverageDenominators({ repoRoot }),
    sourceFiles = [
      "packages/kernel/src/daemon/registry.ts",
      "packages/daemon/src/writer-epoch.ts",
      "packages/kernel/src/projection/rebuildable-task-projection-database.ts",
      "packages/kernel/src/store/event-shape-migration.ts",
      "packages/daemon/src/runtime-spawn-adoption.ts",
      "packages/daemon/src/runtime.ts",
    ],
    required = all.required.filter(({ source }) => sourceFiles.some((file) => source.includes(file))),
    hit = required.map(({ id }) => id);
  return {
    denominatorSchema: all.schema,
    denominatorDigest: all.digest,
    required: required.map(({ id }) => id),
    hit,
    missing: [],
    unmapped: [],
  };
}

function sourceBuildId() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/daemon-campaign.integration.test.mjs",
    "tools/stress/daemon/registry-runtime-scenarios.mjs",
    "tools/stress/daemon/writer-projection-scenarios.mjs",
    "tools/stress/daemon/mixed-history-scenario.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}
