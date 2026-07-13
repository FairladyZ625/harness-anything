import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  actorAxesBindingCoreDigestV2,
  canonicalAttributionEventDigestV2,
  encodeCanonicalCbor,
  physicalChangeSetDigestV2,
  readAttributionProjection,
  rebuildTaskProjection,
  semanticMutationSetDigestV2,
  semanticMutationWireV2
} from "../../packages/kernel/src/index.ts";

const eventCount = positiveIntegerOption("--events", 250);
const rebuildRounds = positiveIntegerOption("--rebuild-rounds", 5);
const headRounds = positiveIntegerOption("--head-rounds", 10);
const rootDir = mkdtempSync(path.join(tmpdir(), "ha-attribution-union-perf-"));
const eventsRoot = path.join(rootDir, "harness/attribution-events");
const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");

try {
  mkdirSync(eventsRoot, { recursive: true });
  for (let revision = 1; revision <= eventCount; revision += 1) writeEvent(revision);

  const rebuildSamplesMs = [];
  for (let round = 0; round < rebuildRounds; round += 1) {
    rmSync(projectionPath, { force: true });
    const startedAt = performance.now();
    rebuildTaskProjection({ rootDir });
    const elapsedMs = performance.now() - startedAt;
    assertRowCount(eventCount);
    rebuildSamplesMs.push(elapsedMs);
  }

  const headVisibilitySamplesMs = [];
  for (let offset = 1; offset <= headRounds; offset += 1) {
    const revision = eventCount + offset;
    writeEvent(revision);
    const committedAt = performance.now();
    rebuildTaskProjection({ rootDir });
    const rows = readAttributionProjection(rootDir);
    if (!rows.some((row) => row.revision === revision)) throw new Error(`revision ${revision} was not visible`);
    headVisibilitySamplesMs.push(performance.now() - committedAt);
  }

  process.stdout.write(`${JSON.stringify({
    schema: "attribution-union-benchmark/v1",
    measuredAt: new Date().toISOString(),
    sourceCommit: git("rev-parse", "HEAD"),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    envelope: { initialEvents: eventCount, rebuildRounds, headRounds },
    gates: { headVisibilityP95MaxMs: 1000, rebuildP95MaxMs: 5000 },
    results: {
      headVisibilityMs: summary(headVisibilitySamplesMs),
      rebuildMs: summary(rebuildSamplesMs)
    }
  }, null, 2)}\n`);
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}

function writeEvent(revision) {
  const event = makeEvent(revision);
  writeFileSync(path.join(eventsRoot, `${String(revision).padStart(6, "0")}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
}

function makeEvent(revision) {
  const mutations = [{
    entity: { registryVersion: 1, entityKind: "fact", canonicalRef: `fact/task_T/F-${revision}` },
    action: { registryVersion: 1, action: "create" }
  }].sort((left, right) => Buffer.compare(
    Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
    Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
  ));
  const mutationSet = { registryVersion: 1, mutations };
  const actorAxesBinding = {
    bindingId: "binding-perf",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent-perf",
    workspaceId: "workspace-perf",
    deviceId: "device-perf",
    viewId: "view-perf",
    sessionId: "session-perf",
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
      commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
    }
  };
  const physicalChanges = [{
    path: "tasks/task_T/facts.md",
    beforeDigest: "11".repeat(32),
    afterDigest: Buffer.from(String(revision)).toString("hex").padEnd(64, "0").slice(0, 64)
  }];
  const core = {
    schema: "attribution-event/v2",
    eventId: `attribution:perf-${revision}`,
    workspaceId: "workspace-perf",
    opId: `perf-${revision}`,
    revision,
    commitSha: `commit-${revision}`,
    previousCommit: revision === 1 ? null : `commit-${revision - 1}`,
    outcome: "COMMITTED",
    occurredAt: new Date(Date.UTC(2026, 6, 13, 0, 0, revision)).toISOString(),
    recordedAt: new Date(Date.UTC(2026, 6, 13, 0, 0, revision, 1)).toISOString(),
    actorAxesBinding,
    semanticRequestDigest: "33".repeat(32),
    mutationSet,
    semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
    actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
    physicalChanges,
    changeSetDigest: hex(physicalChangeSetDigestV2(physicalChanges))
  };
  return { ...core, canonicalEventDigest: hex(canonicalAttributionEventDigestV2(core)) };
}

function assertRowCount(expected) {
  const actual = readAttributionProjection(rootDir).length;
  if (actual !== expected) throw new Error(`expected ${expected} projected rows, received ${actual}`);
}

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMs: samples.map(round),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted, quantile) {
  return round(sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0);
}

function round(value) {
  return Number(value.toFixed(3));
}

function positiveIntegerOption(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function hex(value) {
  return Buffer.from(value).toString("hex");
}

function git(...args) {
  return execFileSync("git", ["-C", process.cwd(), ...args], { encoding: "utf8" }).trim();
}
