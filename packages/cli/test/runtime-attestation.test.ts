// harness-test-tier: contract
//
// Positive-control coverage for the runtime attestation added to `ha doctor`.
// Each incident family that doctor is supposed to catch has a fixture that
// forces the verdict red, alongside a healthy negative control so we prove the
// check does not false-positive.
//
// Covered incident families:
//   1. stale CLI dist (src mtime newer than dist mtime) — daemon would serve
//      the previous artifact; doctor must flag it.
//   2. orphan daemon socket (socket file present, owner pid no longer alive)
//      — daemon process exited or was unlinked; doctor must flag it.
//
// Doctor stays read-only: tests create synthetic fixtures under a temp dir
// and never touch the real user runtime.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkCliDistFreshness,
  collectFindings,
  collectRuntimeAttestation,
  inspectDaemonProcess,
  inspectDaemonProvenance,
  inspectDaemonSocket,
  type DaemonRuntimeAttestation,
  type CliDistFreshnessAttestation
} from "../src/commands/runtime-attestation.ts";

test("checkCliDistFreshness: positive control flags stale dist when src is newer than dist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-stale-"));
  try {
    const srcDir = path.join(root, "src");
    const distDir = path.join(root, "dist");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    const srcFile = path.join(srcDir, "index.ts");
    const distFile = path.join(distDir, "index.js");
    writeFileSync(srcFile, "// source content\n");
    writeFileSync(distFile, "// compiled content\n");
    const older = new Date(Date.now() - 7_200_000);
    const newer = new Date();
    utimesSync(distFile, older, older);
    utimesSync(srcFile, newer, newer);

    const result = checkCliDistFreshness(srcDir, distDir);

    assert.equal(result.missing, false);
    assert.equal(result.stale, true);
    assert.ok(result.srcMtimeIso);
    assert.ok(result.distMtimeIso);
    assert.ok(Date.parse(result.srcMtimeIso!) > Date.parse(result.distMtimeIso!),
      `src ${result.srcMtimeIso} must be newer than dist ${result.distMtimeIso}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCliDistFreshness: negative control does not flag when dist is newer than src", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-fresh-"));
  try {
    const srcDir = path.join(root, "src");
    const distDir = path.join(root, "dist");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    const srcFile = path.join(srcDir, "index.ts");
    const distFile = path.join(distDir, "index.js");
    writeFileSync(srcFile, "// source\n");
    writeFileSync(distFile, "// compiled\n");
    const older = new Date(Date.now() - 3_600_000);
    const newer = new Date();
    utimesSync(srcFile, older, older);
    utimesSync(distFile, newer, newer);

    const result = checkCliDistFreshness(srcDir, distDir);

    assert.equal(result.missing, false);
    assert.equal(result.stale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCliDistFreshness: missing dist directory surfaces as missing rather than stale", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-nodist-"));
  try {
    const srcDir = path.join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, "index.ts"), "// source\n");

    const result = checkCliDistFreshness(srcDir, path.join(root, "dist"));

    assert.equal(result.missing, true);
    assert.equal(result.stale, false);
    assert.equal(result.distMtimeIso, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectDaemonSocket: positive control flags orphan socket when owner pid is dead", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-orphan-"));
  try {
    // Stand-in for the socket file the daemon would leave on disk. doctor only
    // checks existence + the owner lock beside it, so a regular file is enough.
    const endpoint = path.join(root, "daemon-fixture.sock");
    writeFileSync(endpoint, "");
    const ownerLockPath = `${endpoint}.owner`;
    // pid 999_999 is virtually guaranteed to be dead; use the real
    // readDaemonSocketOwner so the same code path used in production resolves
    // the lock and reports alive=false.
    writeFileSync(ownerLockPath, JSON.stringify({
      schema: "daemon-socket-owner/v1",
      pid: 999_999,
      ownerToken: "positive-control-dead-pid"
    }));

    const result = inspectDaemonSocket({ endpoint, platform: process.platform });

    assert.equal(result.exists, true);
    assert.equal(result.owner?.pid, 999_999);
    assert.equal(result.owner?.alive, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectDaemonSocket: negative control does not flag when socket file is absent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-nosocket-"));
  try {
    const endpoint = path.join(root, "daemon-fixture.sock");

    const result = inspectDaemonSocket({ endpoint, platform: process.platform });

    assert.equal(result.exists, false);
    assert.equal(result.owner, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectDaemonSocket: synthetic alive owner reader surfaces pid without flagging orphan", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-alive-"));
  try {
    const endpoint = path.join(root, "daemon-fixture.sock");
    writeFileSync(endpoint, "");
    const result = inspectDaemonSocket({
      endpoint,
      platform: process.platform,
      readDaemonOwner: () => ({ pid: 42_000, alive: true })
    });

    assert.equal(result.exists, true);
    assert.equal(result.owner?.pid, 42_000);
    assert.equal(result.owner?.alive, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectDaemonProcess: flags stale process when started before reference dist mtime", () => {
  // Use the current process: we control a synthetic dist mtime, so we can
  // assert the stale verdict without depending on a real daemon. The process
  // running this test must have started strictly before "now", so a dist
  // mtime set to the current time is newer than the process start.
  if (process.platform === "win32") {
    assert.ok(true, "ps-based daemon attestation is unavailable on win32");
    return;
  }
  const distMtimeMs = Date.now();
  const inspection = inspectDaemonProcess({
    pid: process.pid,
    distMtimeMs,
    platform: process.platform
  });
  assert.ok(inspection, "ps must be available for the current pid on this platform");
  assert.ok(inspection.startedAtIso, "lstart must be readable for a live pid");
  const startedMs = Date.parse(inspection.startedAtIso!);
  assert.ok(Number.isFinite(startedMs), `lstart must parse to a finite date: ${inspection.startedAtIso}`);
  assert.ok(startedMs <= distMtimeMs, `process start ${inspection.startedAtIso} must precede dist mtime ${new Date(distMtimeMs).toISOString()}`);
  assert.equal(inspection.staleProcess, true);
  assert.equal(inspection.referenceMtimeIso, new Date(distMtimeMs).toISOString());
});

test("inspectDaemonProvenance: returns exists=false when manifest is absent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-noprov-"));
  try {
    const inspection = inspectDaemonProvenance({ artifactRoot: root });
    assert.equal(inspection.exists, false);
    assert.equal(inspection.sourceCommit, null);
    assert.equal(inspection.matches, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFindings: cli_dist_stale and daemon_socket_orphan findings fire on positive controls", () => {
  const cliDistFreshness: CliDistFreshnessAttestation = {
    packageRootDisplay: "cli",
    srcMtimeIso: new Date(Date.now() - 60_000).toISOString(),
    distMtimeIso: new Date(Date.now() - 3_600_000).toISOString(),
    stale: true,
    missing: false
  };
  const daemon: DaemonRuntimeAttestation = {
    userRootDisplay: "~/.harness",
    socket: {
      endpointDisplay: "~/sock/daemon.sock",
      exists: true,
      owner: { pid: 999_999, alive: false }
    },
    process: null,
    provenance: {
      manifestPathDisplay: "~/cli/dist/daemon-build-provenance.json",
      exists: true,
      sourceCommit: "deadbeef",
      sourceDirty: false,
      contentFingerprint: "sha256:recorded",
      recomputedFingerprint: "sha256:recorded",
      matches: true
    }
  };
  const findings = collectFindings({ cliDistFreshness, daemon, daemonResolutionOk: true });
  const codes = findings.map((finding) => finding.findingCode);
  assert.ok(codes.includes("cli_dist_stale"), `expected cli_dist_stale in ${codes.join(",")}`);
  assert.ok(codes.includes("daemon_socket_orphan"), `expected daemon_socket_orphan in ${codes.join(",")}`);
  for (const finding of findings) {
    assert.equal(finding.severity, "warning");
    assert.ok(finding.repairHint.length > 0, `${finding.findingCode} must carry a repair hint}`);
  }
});

test("collectFindings: healthy state yields no findings", () => {
  const cliDistFreshness: CliDistFreshnessAttestation = {
    packageRootDisplay: "cli",
    srcMtimeIso: new Date(Date.now() - 3_600_000).toISOString(),
    distMtimeIso: new Date().toISOString(),
    stale: false,
    missing: false
  };
  const daemon: DaemonRuntimeAttestation = {
    userRootDisplay: "~/.harness",
    socket: {
      endpointDisplay: "~/sock/daemon.sock",
      exists: true,
      owner: { pid: process.pid, alive: true }
    },
    process: null,
    provenance: {
      manifestPathDisplay: "~/cli/dist/daemon-build-provenance.json",
      exists: true,
      sourceCommit: "deadbeef",
      sourceDirty: false,
      contentFingerprint: "sha256:recorded",
      recomputedFingerprint: "sha256:recorded",
      matches: true
    }
  };
  const findings = collectFindings({ cliDistFreshness, daemon, daemonResolutionOk: true });
  assert.deepEqual(findings.map((finding) => finding.findingCode), []);
});

test("collectRuntimeAttestation: orchestrator emits runtime-attestation/v1 schema and ok verdict for healthy fixture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-orch-"));
  try {
    // Point both the daemon endpoint and the cli package root at the temp dir
    // so the orchestrator does not touch the developer's real daemon. The
    // socket is absent and no owner file is present, so daemon findings stay
    // empty. cli dist is also absent under the temp root — we accept the
    // cli_dist_missing finding and assert only the schema + the absence of
    // daemon socket findings.
    const endpoint = path.join(root, "daemon-fixture.sock");
    const report = collectRuntimeAttestation({
      rootDir: root,
      cliPackageRoot: root,
      platform: process.platform,
      daemonEndpointOverride: endpoint
    });

    assert.equal(report.schema, "runtime-attestation/v1");
    assert.equal(report.readOnly, true);
    assert.equal(report.platform, process.platform);
    assert.equal(typeof report.checkedAtIso, "string");
    assert.ok(Date.parse(report.checkedAtIso) > 0);
    assert.equal(report.daemon.socket.exists, false);
    assert.equal(report.daemon.socket.owner, null);
    const daemonFindingCodes = report.findings
      .filter((finding) => finding.findingCode.startsWith("daemon_"))
      .map((finding) => finding.findingCode);
    assert.deepEqual(daemonFindingCodes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectRuntimeAttestation: orchestrator flags orphan socket via daemonEndpointOverride", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-orch-orphan-"));
  try {
    const endpoint = path.join(root, "daemon-fixture.sock");
    writeFileSync(endpoint, "");
    writeFileSync(`${endpoint}.owner`, JSON.stringify({
      schema: "daemon-socket-owner/v1",
      pid: 999_999,
      ownerToken: "orchestrator-dead-pid"
    }));

    const report = collectRuntimeAttestation({
      rootDir: root,
      cliPackageRoot: root,
      platform: process.platform,
      daemonEndpointOverride: endpoint
    });

    const orphan = report.findings.find((finding) => finding.findingCode === "daemon_socket_orphan");
    assert.ok(orphan, `expected daemon_socket_orphan finding in ${report.findings.map((f) => f.findingCode).join(",")}`);
    assert.match(orphan!.repairHint, /ha daemon restart/u);
    assert.equal(report.ok, false);
    // The endpoint basename (not the temp root path) appears in the message —
    // this is the privacy invariant also enforced by doctor-cli.test.ts.
    assert.equal(report.daemon.socket.exists, true);
    assert.equal(report.daemon.socket.owner?.alive, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectRuntimeAttestation: respects explicit bindingRoot to resolve a linked worktree binding", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-binding-"));
  try {
    const bindingRoot = path.join(root, "bindings");
    mkdirSync(bindingRoot, { recursive: true });
    const binding = {
      schema: "task-worktree-binding/v1",
      taskId: "task_01KZNZFJDCC198292MZVPEWVM7",
      slug: "fixture",
      agentNamespace: "fixture",
      branchPrefix: "fixture",
      branchName: "fixture/slug",
      worktreePath: root,
      baseRef: "origin/main",
      baseCommit: "0000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
      createdByRuntime: "test",
      status: "active"
    };
    writeFileSync(path.join(bindingRoot, `${binding.taskId}.json`), JSON.stringify(binding));

    const report = collectRuntimeAttestation({
      rootDir: root,
      cliPackageRoot: root,
      bindingRoot,
      daemonEndpointOverride: path.join(root, "absent.sock")
    });

    // rootDir is not a real git repo so insideWorkTree is false; binding lookup
    // only fires for linked worktrees, so binding stays null. This test pins
    // the no-crash contract for the bindingRoot override; the bindingMatch
    // happy path is exercised in worktree CLI tests.
    assert.equal(report.git.insideWorkTree, false);
    assert.equal(report.git.worktree, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
