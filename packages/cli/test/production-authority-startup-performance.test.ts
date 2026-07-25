// harness-test-tier: nightly
// harness-test-tier-decision: dec_01KXZ2WZMB8YS18F549K8BMM7H
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  openDurableAuthorityServiceState,
  requestLocalDaemonJsonRpc
} from "@harness-anything/daemon";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  authorityOperationRecords,
  createFixture,
  git,
  indeterminateWithoutPublication,
  prepareLongHistoryFixture,
  sealLongHistoryFixture
} from "./production-authority-canonical-ingress/fixture.ts";

test("production service exposes its socket while authority recovery scans history, then uses the persisted increment", {
  timeout: 120_000,
  // This benchmark launches one Git observation process per commit. Native
  // Windows writable authority remains deferred, and its process startup cost
  // is not comparable to the qualified POSIX service path measured here.
  skip: process.platform === "win32" ? "production writable recovery performance is POSIX-qualified" : false
}, async (t) => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const recoveryBarrier = installRecoveryScanBarrier(fixture.authoredRoot, fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "35000",
    CODEX_THREAD_ID: "service-recovery-session",
    PATH: `${recoveryBarrier.binRoot}:${process.env.PATH ?? ""}`
  };
  const watermarkPath = path.join(
    fixture.serviceRoot,
    "authority",
    Buffer.from("canonical", "utf8").toString("base64url"),
    "recovery-watermark.json"
  );
  try {
    prepareLongHistoryFixture(fixture.authoredRoot);
    for (let index = 0; index < 800; index += 1) {
      git(fixture.authoredRoot, "commit", "-q", "--allow-empty", "-m", `fixture history ${index}`);
    }
    const coldHead = sealLongHistoryFixture(fixture.authoredRoot);
    const seededState = openDurableAuthorityServiceState({ serviceStateRoot: fixture.serviceRoot, repoId: "canonical" });
    await seededState.operationRegistry.put(indeterminateWithoutPublication());
    await seededState.close();
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));

    const coldStartedAt = Date.now();
    const coldStart = runRawJsonAsync(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    await pollUntil(
      () => existsSync(recoveryBarrier.enteredPath),
      (entered) => entered,
      (entered, error) => JSON.stringify({ entered, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const statusDuringRecovery = await pollUntil(
      () => readDirectDaemonStatus(fixture.repoRoot, userRoot),
      (status) => status.schema === "daemon-status/v2",
      (status, error) => JSON.stringify({ status, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const coldSocketMs = Date.now() - coldStartedAt;
    assert.equal(statusDuringRecovery.schema, "daemon-status/v2", JSON.stringify(statusDuringRecovery));
    assertRecoveryStillInProgress(
      readRecoveryWatermark(watermarkPath),
      "cold full scan must still be in progress when the socket is first reachable"
    );
    recoveryBarrier.release();
    const coldStartReceipt = await coldStart;
    assert.equal(coldStartReceipt.ok, true, JSON.stringify(coldStartReceipt));
    const admittedPromise = runRawJsonAsync(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--text", "must wait for recovery"
    ], env);
    const [admitted] = await Promise.all([admittedPromise, pollUntil(
      () => readRecoveryWatermark(watermarkPath),
      (watermark) => watermark?.schema === "authority-recovery-watermark/v1" && watermark.commitSha === coldHead,
      (watermark, error) => JSON.stringify({ watermark, error: String(error ?? "") }),
      { timeoutMs: 30_000 }
    )]);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    await t.test("positive control: a socket serialized after completed recovery fails the in-progress assertion", async () => {
      const statusAfterRecovery = await readDirectDaemonStatus(fixture.repoRoot, userRoot);
      assert.equal(statusAfterRecovery.schema, "daemon-status/v2", JSON.stringify(statusAfterRecovery));
      assert.throws(
        () => assertRecoveryStillInProgress(
          readRecoveryWatermark(watermarkPath),
          "completed recovery must not satisfy the in-progress signal"
        ),
        /completed recovery must not satisfy the in-progress signal/u
      );
    });
    const coldRecoveryMs = Date.now() - coldStartedAt;
    assert.equal(authorityOperationRecords(fixture.serviceRoot).find((record) => record.opId === "namespace-production:unpublished-startup")?.state, "REJECTED");
    const committed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--text", "recovery completed"
    ], env);
    assert.equal(committed.status, 0, JSON.stringify(committed.receipt));

    await stopDaemon(fixture.repoRoot, userRoot);
    for (let index = 0; index < 5; index += 1) {
      git(fixture.authoredRoot, "commit", "-q", "--allow-empty", "-m", `fixture increment ${index}`);
    }
    const incrementalHead = sealLongHistoryFixture(fixture.authoredRoot);
    const incrementalStartedAt = Date.now();
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    const incrementalSocketMs = Date.now() - incrementalStartedAt;
    await pollUntil(
      () => readRecoveryWatermark(watermarkPath),
      (watermark) => watermark?.schema === "authority-recovery-watermark/v1" && watermark.commitSha === incrementalHead,
      (watermark, error) => JSON.stringify({ watermark, error: String(error ?? "") }),
      { timeoutMs: 10_000 }
    );
    const incrementalRecoveryMs = Date.now() - incrementalStartedAt;
    assert.ok(coldSocketMs < coldRecoveryMs, JSON.stringify({ coldSocketMs, coldRecoveryMs }));
    assert.ok(incrementalRecoveryMs < coldRecoveryMs, JSON.stringify({ incrementalRecoveryMs, coldRecoveryMs }));
    console.log(JSON.stringify({ coldSocketMs, coldRecoveryMs, incrementalSocketMs, incrementalRecoveryMs }));
  } finally {
    recoveryBarrier.release();
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface RecoveryWatermark {
  readonly schema?: string;
  readonly phase?: string;
  readonly commitSha?: string;
}

function readRecoveryWatermark(watermarkPath: string): RecoveryWatermark | undefined {
  return existsSync(watermarkPath)
    ? JSON.parse(readFileSync(watermarkPath, "utf8")) as RecoveryWatermark
    : undefined;
}

function assertRecoveryStillInProgress(
  watermark: RecoveryWatermark | undefined,
  message: string
): void {
  assert.equal(
    watermark === undefined
      || (watermark.schema === "authority-recovery-watermark/v2" && watermark.phase === "partial"),
    true,
    message
  );
}

async function readDirectDaemonStatus(
  repoRoot: string,
  userRoot: string
): Promise<Record<string, unknown>> {
  const response = await requestLocalDaemonJsonRpc(
    repoRoot,
    "repo.daemon.status",
    { repo: { repoId: "canonical" } },
    1_000,
    { userRoot, allowLegacySocket: false }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response.details as { readonly data: Record<string, unknown> }).data;
}

function installRecoveryScanBarrier(
  authoredRoot: string,
  fixtureRoot: string
): {
  readonly binRoot: string;
  readonly enteredPath: string;
  readonly release: () => void;
} {
  const binRoot = path.join(fixtureRoot, "recovery-git-wrapper");
  const enteredPath = path.join(fixtureRoot, "recovery-scan-entered");
  const releasePath = path.join(fixtureRoot, "recovery-scan-release");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(binRoot, { recursive: true });
  const wrapperPath = path.join(binRoot, "git");
  writeFileSync(wrapperPath, [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    'import { existsSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    `const realGit = ${JSON.stringify(realGit)};`,
    `const authoredRoot = ${JSON.stringify(authoredRoot)};`,
    `const enteredPath = ${JSON.stringify(enteredPath)};`,
    `const releasePath = ${JSON.stringify(releasePath)};`,
    "const args = process.argv.slice(2);",
    'if (args[0] === "-C" && path.resolve(args[1] ?? "") === authoredRoot',
    '  && args[2] === "log" && args.includes("--first-parent") && !existsSync(releasePath)) {',
    '  writeFileSync(enteredPath, "entered\\n");',
    "  while (!existsSync(releasePath)) {",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
    "  }",
    "}",
    'const result = spawnSync(realGit, args, { stdio: "inherit" });',
    "if (result.error) throw result.error;",
    "process.exit(result.status ?? 1);",
    ""
  ].join("\n"));
  chmodSync(wrapperPath, 0o755);
  return {
    binRoot,
    enteredPath,
    release: () => {
      if (!existsSync(releasePath)) writeFileSync(releasePath, "released\n");
    }
  };
}
