// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyRemoteGitInvocation,
  writePortExternalObservation,
} from "../src/daemon-host/write-port-external-observation.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("write-port external-wait counts only while the serialized turn runs", async () => {
  writePortExternalObservation.reset();
  assert.deepEqual(writePortExternalObservation.snapshot(), {
    networkRoundTrips: 0,
    remoteChildProcesses: 0,
  });
  writePortExternalObservation.noteNetworkRoundTrip();
  assert.deepEqual(writePortExternalObservation.snapshot(), {
    networkRoundTrips: 0,
    remoteChildProcesses: 0,
  });
  await writePortExternalObservation.runInWritePort(async () => {
    writePortExternalObservation.noteNetworkRoundTrip();
    writePortExternalObservation.noteRemoteChildProcess();
    assert.equal(writePortExternalObservation.currentDepth(), 1);
  });
  assert.deepEqual(writePortExternalObservation.snapshot(), {
    networkRoundTrips: 1,
    remoteChildProcesses: 1,
  });
});

test("classifyRemoteGitInvocation treats unknown remotes conservatively", async () => {
  assert.equal(await classifyRemoteGitInvocation("git", ["fetch", "--quiet", "origin"], "/tmp/unset"), true);
  assert.equal(await classifyRemoteGitInvocation("git", ["rev-parse", "HEAD"], "/tmp/unset"), false);
});

test("classifyRemoteGitInvocation handles the raw Windows Git push before cmd.exe wrapping", async () => {
  assert.equal(
    await classifyRemoteGitInvocation(
      "git.exe",
      ["-C", "C:\\worker\\repo", "push", "--force-with-lease", "https://g38.invalid/repo.git", "HEAD:refs/heads/task"],
      "C:\\worker\\repo",
    ),
    true,
  );
});

test("classifyRemoteGitInvocation surfaces malformed Git endpoint lookup data", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ha-g38-invalid-gitdir-"));
  t.after(() => removeTempRepository(cwd));
  writeFileSync(path.join(cwd, ".git"), "not a gitdir pointer\n", "utf8");
  await assert.rejects(
    classifyRemoteGitInvocation("git", ["fetch", "origin"], cwd),
    /Git worktree \.git file has no gitdir path/u,
  );
});
