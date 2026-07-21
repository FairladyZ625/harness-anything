// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "@harness-anything/daemon";
import {
  runDaemonControl,
  type DaemonControlLifecycle,
  type DaemonControlRequest
} from "../src/commands/daemon/control.ts";

const launchConfiguration = {
  execPath: process.execPath,
  execArgv: [],
  entrypoint: "/daemon.js",
  args: ["daemon", "serve"]
};

test("POSIX control probes generation capability and carries the expected generation", async () => {
  let requested: DaemonControlRequest | undefined;
  const result = await runDaemonControl({
    rootDir: "/repo",
    args: [],
    daemonEntryPath: () => "/daemon.js",
    platform: "linux",
    requestDaemonControl: async (request) => {
      requested = request;
      return acceptedReceipt(7);
    },
    daemonControlLifecycle: lifecycle(generationStatus(42, 7))
  }, "restart");

  assert.equal((requested?.params.payload as JsonObject).daemonGeneration, 7);
  const replacement = result.replacement as Record<string, unknown>;
  assert.equal((replacement.service as Record<string, unknown>).daemonGeneration, 8);
});

test("POSIX control fails closed before mutation when generation capability is incomplete", async () => {
  let requested = false;
  await assert.rejects(
    runDaemonControl({
      rootDir: "/repo",
      args: [],
      daemonEntryPath: () => "/daemon.js",
      platform: "linux",
      requestDaemonControl: async () => {
        requested = true;
        return acceptedReceipt(7);
      },
      daemonControlLifecycle: lifecycle(legacyStatus(42))
    }, "restart"),
    /DAEMON_GENERATION_CAPABILITY_INCOMPLETE/u
  );
  assert.equal(requested, false);
});

test("Windows control explicitly degrades a missing generation capability to legacy", async () => {
  let requested: DaemonControlRequest | undefined;
  await runDaemonControl({
    rootDir: "C:\\repo",
    args: [],
    daemonEntryPath: () => "C:\\daemon.js",
    platform: "win32",
    requestDaemonControl: async (request) => {
      requested = request;
      return acceptedReceipt();
    },
    daemonControlLifecycle: lifecycle(legacyStatus(42), legacyStatus(84))
  }, "restart");
  assert.equal((requested?.params.payload as JsonObject).daemonGeneration, undefined);
});

function lifecycle(
  capabilityStatus: Record<string, unknown>,
  replacementStatus = generationStatus(84, 8)
): DaemonControlLifecycle {
  return {
    target: { canonicalRoot: "/repo", repoId: "canonical", userRoot: "/user", daemonId: "daemon", socketPath: "/socket" },
    probeGenerationStatus: async () => capabilityStatus,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => replacementStatus,
    wait: async () => undefined
  };
}

function acceptedReceipt(daemonGeneration?: number): Record<string, unknown> {
  return {
    schema: "daemon-control-accepted/v1",
    accepted: true,
    operationId: "control-restart",
    kind: "restart",
    ...(daemonGeneration ? { machineId: "machine-installation-a", daemonGeneration } : {}),
    before: {
      pid: 42,
      loadedIdentity: "sha256:old",
      launchConfiguration,
      ...(daemonGeneration ? { daemonGeneration } : {})
    }
  };
}

function generationStatus(pid: number, daemonGeneration: number): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity: "sha256:new", installedIdentity: "sha256:new" },
      activeControl: null,
      machineId: "machine-installation-a",
      daemonGeneration
    }
  };
}

function legacyStatus(pid: number): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity: "sha256:new", installedIdentity: "sha256:new" },
      activeControl: null
    }
  };
}
