import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRemoteGitInvocation,
  writePortExternalObservation,
} from "../src/daemon-host/write-port-external-observation.ts";

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

test("classifyRemoteGitInvocation treats local file origins as non-remote", () => {
  assert.equal(
    classifyRemoteGitInvocation("git", ["fetch", "--quiet", "origin"], "/tmp/unset"),
    true,
    "unknown cwd keeps conservative remote classification",
  );
  assert.equal(classifyRemoteGitInvocation("git", ["rev-parse", "HEAD"], "/tmp/unset"), false);
});