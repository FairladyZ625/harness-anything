// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNodeTestIsolationIdentityBroker,
  NODE_TEST_ISOLATION_REGISTRY_ENV,
  readRegisteredTestIsolations,
  registerCurrentTestIsolation,
  shouldUseNodeTestIsolationRegistry
} from "./node-test-isolation-registry.mjs";
import { reapPostCompletionChild } from "./node-test-process-tree.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const selectedFile = "tools/node-test-stall-policy.test.mjs";
const absoluteFile = path.join(repoRoot, selectedFile);

test("test isolation registration binds one selected file to its owning host", async () => {
  const registryRoot = mkdtempSync(path.join(tmpdir(), "ha-test-isolation-registry-"));
  const broker = await createNodeTestIsolationIdentityBroker();
  let registration;
  try {
    registration = await registerCurrentTestIsolation({
      env: {
        NODE_TEST_CONTEXT: "child-v8",
        [NODE_TEST_ISOLATION_REGISTRY_ENV]: registryRoot,
        ...broker.environment
      },
      pid: 48001,
      ppid: 47001,
      argv: [process.execPath, absoluteFile]
    });

    assert.equal(registration.recordPath, path.join(registryRoot, "48001.json"));
    assert.deepEqual(JSON.parse(readFileSync(registration.recordPath, "utf8")), registration.record);
    assert.deepEqual(await readRegisteredTestIsolations({
      registryRoot,
      repoRoot,
      hostPid: 47001,
      selectedFiles: [selectedFile],
      isProcessAlive: (pid) => pid === 48001,
      probeIdentity: broker.matches
    }), [{
      pid: 48001,
      ppid: 47001,
      files: [selectedFile],
      identity: registration.record.identity
    }]);
    assert.deepEqual(await readRegisteredTestIsolations({
      registryRoot,
      repoRoot,
      hostPid: 47002,
      selectedFiles: [selectedFile],
      isProcessAlive: () => true,
      probeIdentity: broker.matches
    }), []);
    const staleRecord = registration.record;
    registration.dispose();
    await new Promise((resolveClose) => setTimeout(resolveClose, 25));
    writeFileSync(registration.recordPath, `${JSON.stringify(staleRecord)}\n`);
    assert.deepEqual(await readRegisteredTestIsolations({
      registryRoot,
      repoRoot,
      hostPid: 47001,
      selectedFiles: [selectedFile],
      isProcessAlive: () => true,
      probeIdentity: broker.matches
    }), []);
  } finally {
    registration?.dispose();
    broker.dispose();
    rmSync(registryRoot, { recursive: true, force: true });
  }
});

test("test isolation registry rejects a recycled PID with a different live identity", async () => {
  const registryRoot = mkdtempSync(path.join(tmpdir(), "ha-test-isolation-recycle-"));
  const record = {
    schema: "node-test-isolation/v1",
    pid: 48003,
    ppid: 47001,
    files: [absoluteFile],
    identity: { token: "11111111-1111-4111-8111-111111111111" }
  };
  try {
    writeFileSync(path.join(registryRoot, "48003.json"), `${JSON.stringify(record)}\n`);
    const read = (probeIdentity) => readRegisteredTestIsolations({
      registryRoot,
      repoRoot,
      hostPid: 47001,
      selectedFiles: [selectedFile],
      isProcessAlive: () => true,
      probeIdentity
    });

    assert.deepEqual(await read(async () => false), []);
    assert.deepEqual(await read(async (candidate) => candidate.identity.token === record.identity.token), [{
      pid: 48003,
      ppid: 47001,
      files: [selectedFile],
      identity: record.identity
    }]);
  } finally {
    rmSync(registryRoot, { recursive: true, force: true });
  }
});

test("test isolation registration collisions and storage failures never fail test preload", async () => {
  const registryRoot = mkdtempSync(path.join(tmpdir(), "ha-test-isolation-collision-"));
  const broker = await createNodeTestIsolationIdentityBroker();
  const registrationInput = {
    env: {
      NODE_TEST_CONTEXT: "child-v8",
      [NODE_TEST_ISOLATION_REGISTRY_ENV]: registryRoot,
      ...broker.environment
    },
    pid: 48004,
    ppid: 47001,
    argv: [process.execPath, absoluteFile]
  };
  try {
    writeFileSync(path.join(registryRoot, "48004.json"), "stale record\n");
    let registration;
    await assert.doesNotReject(async () => {
      registration = await registerCurrentTestIsolation(registrationInput);
    });
    assert.deepEqual(JSON.parse(readFileSync(registration.recordPath, "utf8")), registration.record);
    registration.dispose();

    await assert.doesNotReject(async () => {
      const unavailable = await registerCurrentTestIsolation({
        ...registrationInput,
        pid: 48005,
        env: {
          ...registrationInput.env,
          [NODE_TEST_ISOLATION_REGISTRY_ENV]: path.join(registryRoot, "missing")
        }
      });
      assert.equal(unavailable, null);
    });
  } finally {
    broker.dispose();
    rmSync(registryRoot, { recursive: true, force: true });
  }
});

test("test isolation registry leaves ordinary POSIX runner behavior unchanged", () => {
  assert.equal(shouldUseNodeTestIsolationRegistry({ platform: "win32" }), true);
  assert.equal(shouldUseNodeTestIsolationRegistry({ platform: "linux" }), false);
  assert.equal(shouldUseNodeTestIsolationRegistry({
    platform: "darwin",
    fixtureMode: "post-complete-wedge",
    fixtureFiles: ["tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs"]
  }), true);
});

test("post-completion reap revalidates process identity after diagnostics", async () => {
  let diagnosticsCaptured = false;
  let terminationCalled = false;
  const reaped = await reapPostCompletionChild({
    hostPid: 47001,
    isolationChildPid: 48006,
    file: selectedFile,
    identity: { token: "22222222-2222-4222-8222-222222222222" },
    probeIdentity: async () => false,
    captureDiagnostics: async () => {
      diagnosticsCaptured = true;
    },
    terminateProcessTree: async () => {
      terminationCalled = true;
      return true;
    }
  });

  assert.equal(diagnosticsCaptured, true);
  assert.equal(terminationCalled, false);
  assert.equal(reaped, false);
});
