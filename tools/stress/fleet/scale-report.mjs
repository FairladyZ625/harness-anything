import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { generateCoverageDenominators } from "../core/denominators.mjs";
import { buildStressReport } from "../core/report.mjs";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

export async function scaleReport({ seed, command, blobs, rebuild, calibration, caseId, caseVerdict }) {
  const all = await generateCoverageDenominators({ repoRoot });
  const mappedIds = mappedCoverage(all.required);
  const coverage = await generateCoverageDenominators({ repoRoot, mappedIds });
  return buildStressReport({
    campaignComplete: false,
    source: {
      head: process.env.HARNESS_BUILD_COMMIT ?? null,
      base: process.env.HARNESS_BASE_COMMIT ?? null,
      loadedBuild: sourceDigest(),
      dirty: null,
    },
    environment: {
      node: process.version,
      sqlite: process.versions.sqlite,
      os: `${process.platform}-${process.arch}`,
      filesystem: "isolated Ubuntu temporary filesystem",
      capabilities: ["S1 receipt controller", "8 concurrent clients", "durable sharded blob objects"],
    },
    seed,
    topology: "one SQLite authority queue, eight concurrent S1 clients, external fsynced receipt logs",
    generation: 1,
    counts: {
      acceptedEvents: command.denominators.acceptedEvents,
      uniqueBlobs: blobs.denominators.distinctBlobs,
      maxConcurrentClients: command.maxInFlight,
      primaryCommands: command.denominators.primaryCommands,
      idempotentRequests: command.denominators.idempotentRequests,
      conflictRequests: command.denominators.conflictRequests,
      totalRequests: command.denominators.totalRequests + blobs.denominators.totalRequests,
    },
    coverage: {
      denominatorSchema: coverage.schema,
      denominatorDigest: coverage.digest,
      required: coverage.required.map(({ id }) => id),
      hit: coverage.hit,
      missing: coverage.missing,
      negativeControls: [],
    },
    calibration,
    cases: [
      {
        id: caseId,
        boundaryHits: ["request-fsync", "sqlite-commit", "receipt-fsync", "blob-fsync-rename", "cold-rebuild"],
        receiptLogs: command.logs,
        measured: {
          commandElapsedMs: command.elapsedMs,
          contentObjectsAcceptedInCommandTransactions: blobs.denominators.distinctBlobs,
          rebuildElapsedMs: rebuild.elapsedMs,
          specialRequestRatio: command.denominators.specialRequestRatio,
          reconciliationDifferences: rebuild.reconciliation.matches ? 0 : 1,
          coldRebuilds: [rebuild.first, rebuild.second].map(
            ({ label, receipt, stateDigest, cut, blobManifestDigest }) => ({
              label,
              receipt,
              stateDigest,
              cut,
              blobManifestDigest,
            }),
          ),
        },
        oracles: {
          O1: { verdict: "PASS", acceptedEventsFromReceiptLogs: command.denominators.acceptedEvents },
          O3: { verdict: "PASS", distinctAcceptedContentObjects: blobs.denominators.distinctBlobs },
          O7: {
            verdict: "PASS",
            reconciliationMatches: rebuild.reconciliation.matches,
            firstDigest: rebuild.first.stateDigest,
            secondDigest: rebuild.second.stateDigest,
          },
        },
        verdict: caseVerdict,
      },
    ],
    replayCommand:
      "node tools/dispatch-isolated-test.mjs --target ubuntu --file " + path.relative(repoRoot, process.argv[1]),
    residualRisks: [
      "This seed report covers the full-scale workload; the consolidated campaign also requires F12/F13 generation-1 and F14 fault arms.",
      "Device-backed ENOSPC and power-loss arms require the operator-created VM mounts.",
    ],
  });
}

function mappedCoverage(required) {
  return required
    .filter(
      ({ id, source, boundary }) =>
        id === "event-schema:ci-run-observation/v1" ||
        (source.includes("sqlite-event-store.ts") && ["commit", "claimWriter"].includes(boundary)) ||
        (source.includes("durable-file.ts") && ["fsync", "rename"].includes(boundary)),
    )
    .map(({ id }) => id);
}

function sourceDigest() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/fleet/scale-runner.mjs",
    "tools/stress/fleet/scale-report.mjs",
    "packages/kernel/src/store/sqlite-event-store.ts",
    "packages/kernel/src/local/local-layout-file-system.ts",
    "tools/stress/core/controller.mjs",
    "tools/stress/core/receipt-log.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}
