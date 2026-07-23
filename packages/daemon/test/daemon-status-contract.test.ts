// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonStatusResultV2 } from "../../application/src/index.ts";
import {
  calculateDaemonArtifactIdentity,
  daemonStatusPayload,
  decodeDaemonStatusRequestV2,
  decodeDaemonStatusResultV2,
  projectDaemonStatusForRenderer
} from "../src/index.ts";

function measureArtifactContentHashBaseline(artifactRoot: string): number {
  const started = process.hrtime.bigint();
  const files: string[] = [];
  const pending = [artifactRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const digest = createHash("sha256");
  for (const file of files) digest.update(readFileSync(file));
  digest.digest();
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

test("daemon artifact identity is deterministic over the adjudicated regular-file set", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-artifact-"));
  try {
    const dist = path.join(root, "dist");
    mkdirSync(path.join(dist, "nested"), { recursive: true });
    writeFileSync(path.join(dist, "index.js"), "export const value = 1;\n");
    writeFileSync(path.join(dist, "nested/data.json"), '{"ok":true}\n');
    writeFileSync(path.join(dist, "nested/ignored.map"), "ignored");
    writeFileSync(path.join(dist, "nested/ignored.d.ts"), "ignored");
    symlinkSync(path.join(dist, "index.js"), path.join(dist, "nested/link.js"));

    const first = calculateDaemonArtifactIdentity(path.join(dist, "index.js"));
    const second = calculateDaemonArtifactIdentity(path.join(dist, "index.js"));
    assert.equal(first.artifactRoot, realpathSync(dist));
    assert.equal(first.fileCount, 2);
    assert.match(first.identity, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(second.identity, first.identity);

    writeFileSync(path.join(dist, "nested/data.json"), '{"ok":false}\n');
    assert.notEqual(calculateDaemonArtifactIdentity(path.join(dist, "index.js")).identity, first.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source daemon artifact identity covers CLI build inputs and remains deterministic", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-source-artifact-"));
  try {
    const entrypoint = path.join(root, "packages", "cli", "src", "index.ts");
    const daemonSource = path.join(root, "packages", "daemon", "src", "index.ts");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    mkdirSync(path.dirname(daemonSource), { recursive: true });
    writeFileSync(entrypoint, "export const cli = true;\n");
    writeFileSync(daemonSource, "export const daemon = 1;\n");
    writeFileSync(path.join(path.dirname(daemonSource), "types.d.ts"), "export type Ignored = true;\n");

    const first = calculateDaemonArtifactIdentity(entrypoint);
    const unchanged = calculateDaemonArtifactIdentity(entrypoint);
    assert.equal(first.artifactRoot, realpathSync(root));
    assert.equal(first.fileCount, 2);
    assert.equal(unchanged.identity, first.identity);

    writeFileSync(entrypoint, "export const cli = false;\n");
    assert.notEqual(calculateDaemonArtifactIdentity(entrypoint).identity, first.identity);
    writeFileSync(entrypoint, "export const cli = true;\n");
    writeFileSync(daemonSource, "export const daemon = 2;\n");
    assert.notEqual(calculateDaemonArtifactIdentity(entrypoint).identity, first.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("representative installed artifact identity has bounded relative overhead", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-installed-artifact-"));
  try {
    const dist = path.join(root, "dist");
    const entrypoint = path.join(dist, "cli/src/index.js");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, "export const cli = true;\n");
    for (let index = 1; index < 256; index += 1) {
      const modulePath = path.join(
        dist,
        `chunk-${String(index % 16).padStart(2, "0")}`,
        `module-${String(index).padStart(3, "0")}.js`
      );
      mkdirSync(path.dirname(modulePath), { recursive: true });
      writeFileSync(modulePath, `export const artifact${index} = ${JSON.stringify("x".repeat(1_024))};\n`);
    }

    calculateDaemonArtifactIdentity(entrypoint);
    measureArtifactContentHashBaseline(dist);
    // Alternate arm order so same-window runner or cache drift affects both sides of the paired median.
    const pairs = Array.from({ length: 9 }, (_, index) => {
      if (index % 2 === 0) {
        const identity = calculateDaemonArtifactIdentity(entrypoint);
        const baselineMs = measureArtifactContentHashBaseline(dist);
        return { identity, baselineMs };
      }
      const baselineMs = measureArtifactContentHashBaseline(dist);
      const identity = calculateDaemonArtifactIdentity(entrypoint);
      return { identity, baselineMs };
    });
    const samples = pairs.map((pair) => pair.identity);
    assert.equal(new Set(samples.map((sample) => sample.identity)).size, 1);
    assert.equal(samples[0]!.artifactRoot, realpathSync(dist));
    assert.equal(samples[0]!.fileCount, 256);
    const ratios = pairs
      .map((pair) => pair.identity.elapsedMs / pair.baselineMs)
      .sort((left, right) => left - right);
    const medianRatio = ratios[Math.floor(ratios.length / 2)]!;
    const slowestRatio = ratios.at(-1)!;
    const maximumMedianRatio = 2;
    t.diagnostic(`artifact identity relative overhead median=${medianRatio.toFixed(2)}x slowest=${slowestRatio.toFixed(2)}x`);
    assert.equal(
      medianRatio <= maximumMedianRatio,
      true,
      `median artifact identity relative overhead was ${medianRatio.toFixed(2)}x`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon status v2 aggregates every repo and derives a renderer-safe projection", () => {
  const loadedIdentity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const installedIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const status = daemonStatusPayload({
    daemonId: "daemon-test",
    rootDir: "/repo/alpha",
    repoId: "alpha",
    endpoint: "/user/daemon.sock",
    userRoot: "/user",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    loadedIdentity,
    version: "0.1.0-test",
    readInstalledIdentity: () => installedIdentity,
    includeDeploymentIdentity: true,
    readDeploymentStatus: () => ({
      entrypoint: "/repo/ha/packages/cli/dist/cli/src/index.js",
      artifactRoot: "/repo/ha/packages/cli/dist",
      provenance: {
        kind: "build-manifest",
        sourceCommit: "a".repeat(40),
        sourceDirty: false,
        sourceFingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        contentFingerprint: loadedIdentity,
        contentMatchesLoaded: true,
        reason: "recorded artifact fingerprint matches the bytes loaded at daemon start"
      },
      checkout: {
        root: "/repo/ha",
        currentCommit: "a".repeat(40),
        currentDirty: false,
        currentSourceFingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        matchesProvenance: true
      },
      supervision: {
        kind: "systemd-system",
        unit: "harness-anything-daemon.service",
        managerState: "active",
        observedPid: process.pid,
        matchesPid: true,
        reason: "service manager reports this daemon PID as its active main process"
      },
      healthy: true,
      failures: []
    }),
    activeControl: {
      operationId: "control-stuck",
      kind: "refresh",
      phase: "failed",
      requestedAt: "2026-07-20T00:00:00.000Z",
      failure: {
        code: "daemon_queue_drain_timeout",
        hint: "in-flight operations failed to settle in time"
      }
    },
    runtimeStatus: {
      started: true,
      repos: [
        {
          repoId: "alpha",
          canonicalRoot: "/repo/alpha",
          state: "attached",
          lockPath: ".harness/journal/global.lock",
          lockOwnerToken: "alpha-owner",
          queue: {
            interactive: 1,
            normal: 0,
            background: 0,
            maintenance: 0,
            running: true,
            admission: {
              limits: { maxOperations: 1024, maxBytes: 1_048_576, reservedOperationsPerPlane: 32, reservedBytesPerPlane: 65_536 },
              used: { operations: 3, bytes: 300, authorityOperations: 2, authorityBytes: 200, jsonRpcOperations: 1, jsonRpcBytes: 100 },
              rejected: { authority: 4, "json-rpc": 5 }
            }
          }
        },
        {
          repoId: "beta",
          canonicalRoot: "/repo/beta",
          state: "unavailable",
          queue: { interactive: 0, normal: 1, background: 1, maintenance: 0, running: false },
          lastError: "lock held"
        }
      ]
    },
    connections: { active: 1, total: 4 }
  });

  assert.equal(status.schema, "daemon-status/v2");
  assert.equal(status.daemonId, status.service.daemonId);
  assert.equal(status.pid, status.service.pid);
  assert.equal(status.started, status.service.started);
  assert.equal(status.rootDir, status.requestedRepo.canonicalRoot);
  assert.equal(status.repoId, status.requestedRepo.repoId);
  assert.equal(status.projectionGeneration, status.requestedRepo.projectionGeneration);
  assert.equal(status.service.queue.depth, 3);
  assert.equal(status.service.queue.admission?.used.operations, 3);
  assert.equal(status.requestedRepo.queue.admission?.rejected["json-rpc"], 5);
  assert.equal(status.service.repoCount, 2);
  assert.equal(status.service.attachedCount, 1);
  assert.equal(status.service.unavailableCount, 1);
  assert.equal(status.service.build.stale, true);
  assert.equal(status.service.deployment?.healthy, true);
  assert.equal(status.requestedRepo.repoId, "alpha");
  assert.equal(status.repos[1]?.lastError, "lock held");

  const projected = projectDaemonStatusForRenderer(status);
  assert.equal(JSON.stringify(projected).includes("ownerToken"), false);
  assert.equal(projected.requestedRepo.lock.path, status.requestedRepo.lock.path);
  assert.equal(status.requestedRepo.lock.ownerToken, "alpha-owner");
  assert.doesNotThrow(() => decodeDaemonStatusResultV2(status));
  assert.equal(status.service.activeControl?.failure?.code, "daemon_queue_drain_timeout");
});

test("renderer-safe projection is generated from the canonical fixture without mutating it", () => {
  const fixturePath = path.resolve("packages/daemon/fixtures/api-schemas/daemon.status-result__v2/valid.json");
  const canonical = JSON.parse(readFileSync(fixturePath, "utf8")) as DaemonStatusResultV2;
  const projected = projectDaemonStatusForRenderer(canonical);
  assert.equal(JSON.stringify(projected).includes("ownerToken"), false);
  assert.equal(canonical.requestedRepo.lock.ownerToken, "lock-canonical");
  assert.deepEqual(projected.repos.map((repo) => repo.repoId), canonical.repos.map((repo) => repo.repoId));
});

test("daemon status v2 schema fixtures prove request and result boundaries", () => {
  const fixtureRoot = path.resolve("packages/daemon/fixtures/api-schemas");
  const contracts = [
    ["daemon.status-request__v2", decodeDaemonStatusRequestV2],
    ["daemon.status-result__v2", decodeDaemonStatusResultV2]
  ] as const;
  for (const [fixture, decode] of contracts) {
    assert.doesNotThrow(() => decode(JSON.parse(readFileSync(path.join(fixtureRoot, fixture, "valid.json"), "utf8"))), fixture);
    assert.throws(() => decode(JSON.parse(readFileSync(path.join(fixtureRoot, fixture, "invalid.json"), "utf8"))), fixture);
  }
});

test("daemon status generation capability preserves legacy bytes and validates the full projection", () => {
  const fixturePath = path.resolve("packages/daemon/fixtures/api-schemas/daemon.status-result__v2/valid.json");
  const legacy = JSON.parse(readFileSync(fixturePath, "utf8")) as DaemonStatusResultV2;
  const before = Buffer.from(JSON.stringify(legacy));
  assert.doesNotThrow(() => decodeDaemonStatusResultV2(legacy));
  const after = Buffer.from(JSON.stringify(legacy));
  assert.equal(after.equals(before), true, "legacy daemon status fixture bytes drifted");

  assert.deepEqual(decodeDaemonStatusRequestV2({ repo: { repoId: "canonical" } }), {
    repo: { repoId: "canonical" }
  });
  assert.deepEqual(decodeDaemonStatusRequestV2({
    repo: { repoId: "canonical" },
    includeGenerationAxes: true
  }), {
    repo: { repoId: "canonical" },
    includeGenerationAxes: true
  });
  assert.deepEqual(decodeDaemonStatusRequestV2({
    repo: { repoId: "canonical" },
    includeGenerationAxes: true,
    includeDeploymentIdentity: true
  }), {
    repo: { repoId: "canonical" },
    includeGenerationAxes: true,
    includeDeploymentIdentity: true
  });
  assert.throws(() => decodeDaemonStatusRequestV2({
    repo: { repoId: "canonical" },
    includeGenerationAxes: false
  }));

  const full: DaemonStatusResultV2 = {
    ...legacy,
    connectionId: "connection-a",
    service: {
      ...legacy.service,
      machineId: "machine-installation-a",
      daemonGeneration: 3
    },
    requestedRepo: {
      ...legacy.requestedRepo,
      runtimeRegistrationId: "runtime-a",
      daemonGeneration: 3
    },
    repos: legacy.repos.map((repo) => ({ ...repo, daemonGeneration: 3 }))
  };
  assert.doesNotThrow(() => decodeDaemonStatusResultV2(full));
});

test("generation-aware control remains byte-identical for a legacy status request", () => {
  const common = {
    daemonId: "daemon-test",
    rootDir: "/repo/alpha",
    repoId: "alpha",
    endpoint: "/user/daemon.sock",
    userRoot: "/user",
    startedAt: "2999-01-01T00:00:00.000Z",
    loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version: "0.1.0-test",
    readInstalledIdentity: () => "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runtimeStatus: {
      started: true,
      repos: [{
        repoId: "alpha",
        canonicalRoot: "/repo/alpha",
        state: "attached",
        queue: { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false }
      }]
    },
    connections: { active: 1, total: 1 }
  } as const;
  const legacyControl = {
    operationId: "control-a",
    kind: "refresh",
    phase: "accepted",
    requestedAt: "2026-07-21T00:00:00.000Z"
  } as const;
  const expected = Buffer.from(JSON.stringify(daemonStatusPayload({
    ...common,
    activeControl: legacyControl
  })));
  const actual = Buffer.from(JSON.stringify(daemonStatusPayload({
    ...common,
    activeControl: {
      ...legacyControl,
      machineId: "machine-installation-a",
      daemonGeneration: 4
    }
  })));
  assert.equal(actual.equals(expected), true, "legacy status producer leaked control generation axes");

  const capable = daemonStatusPayload({
    ...common,
    activeControl: { ...legacyControl, machineId: "machine-installation-a", daemonGeneration: 4 },
    generationAxes: { machineId: "machine-installation-a", daemonGeneration: 4 },
    includeGenerationAxes: true
  });
  assert.equal(capable.service.activeControl?.daemonGeneration, 4);
});
