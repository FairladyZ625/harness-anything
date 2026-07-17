// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeKind, RuntimeSession } from "../../kernel/src/index.ts";
import {
  discoverRuntimeInstallations,
  makeAgentRuntimeService,
  type AgentRuntimeDiscoveryProbe,
  type RuntimeExecutableCandidate
} from "../src/index.ts";

const baseKind: RuntimeKind = {
  kindId: "base",
  displayName: "Base",
  protocolFamily: "plain-text",
  executableNames: ["base"],
  environmentOverride: "BASE_PATH",
  appBundleCandidates: [],
  capabilities: [],
  authenticationProfiles: []
};

test("discovery follows override, PATH, one login shell, then app bundle with verification", async () => {
  const kinds = ["override", "path", "shell", "bundle"].map((kindId) => ({ ...baseKind, kindId }));
  const calls: string[] = [];
  const probe = fakeProbe({
    environmentOverride: async (kind) => {
      calls.push(`env:${kind.kindId}`);
      return kind.kindId === "override" ? found(kind.kindId, "environment-override") : undefined;
    },
    path: async (kind) => {
      calls.push(`path:${kind.kindId}`);
      return kind.kindId === "path" ? found(kind.kindId, "path") : undefined;
    },
    loginShell: async (unresolved) => {
      calls.push(`shell:${unresolved.map(({ kindId }) => kindId).join(",")}`);
      return [found("shell", "login-shell")];
    },
    appBundle: async (kind) => {
      calls.push(`bundle:${kind.kindId}`);
      return found(kind.kindId, "app-bundle");
    },
    verify: async (candidate) => {
      calls.push(`verify:${candidate.kindId}:${candidate.source}`);
      return { executable: true };
    }
  });

  const result = await discoverRuntimeInstallations(kinds, probe, 50);

  assert.deepEqual(result.map(({ candidate }) => [candidate.kindId, candidate.source]), [
    ["override", "environment-override"],
    ["path", "path"],
    ["shell", "login-shell"],
    ["bundle", "app-bundle"]
  ]);
  assert.equal(calls.filter((call) => call.startsWith("shell:")).length, 1);
  assert.equal(calls.includes("path:override"), false);
  assert.equal(calls.includes("bundle:shell"), false);
});

test("login-shell timeout falls through to app bundle and re-verifies its candidate", async () => {
  const calls: string[] = [];
  const probe = fakeProbe({
    loginShell: () => new Promise(() => undefined),
    appBundle: async (kind) => found(kind.kindId, "app-bundle"),
    verify: async (candidate) => {
      calls.push(candidate.source);
      return { executable: true };
    }
  });

  const result = await discoverRuntimeInstallations([{ ...baseKind, kindId: "bundle" }], probe, 5);

  assert.equal(result[0]?.candidate.source, "app-bundle");
  assert.deepEqual(calls, ["app-bundle"]);
});

test("binary discovery does not promote authentication, running, or attachability", async () => {
  const service = makeAgentRuntimeService({
    kinds: [{ ...baseKind, kindId: "codex" }],
    discovery: fakeProbe({ path: async (kind) => found(kind.kindId, "path") }),
    now: () => "2026-07-17T12:00:00.000Z"
  });

  const inventory = await service.inventory();

  assert.deepEqual(inventory.installations[0]?.states, {
    installed: { state: true, reason: "executable-verified", observedAt: "2026-07-17T12:00:00.000Z" },
    authenticated: { state: "unknown", reason: "authentication-not-probed" },
    running: { state: "unknown", reason: "process-witness-unavailable" },
    attachable: { state: "unknown", reason: "evidence-unavailable" }
  });
});

test("independent evidence can represent mixed true, false, and unknown states", async () => {
  const service = makeAgentRuntimeService({
    kinds: [{ ...baseKind, kindId: "codex" }],
    discovery: fakeProbe({ path: async (kind) => found(kind.kindId, "path") }),
    assessInstallation: async () => ({
      authenticated: { state: false, reason: "profile-not-authenticated" },
      running: { state: true, reason: "process-alive" },
      attachable: { state: "unknown", reason: "evidence-unavailable" }
    })
  });

  const states = (await service.inventory()).installations[0]?.states;
  assert.equal(states?.installed.state, true);
  assert.equal(states?.authenticated.state, false);
  assert.equal(states?.running.state, true);
  assert.equal(states?.attachable.state, "unknown");
});

test("safe projection is rebuilt and strips raw paths, process ids, provider ids, and client ownership", async () => {
  let reads = 0;
  const session: RuntimeSession = {
    runtimeSessionId: "runtime-session-1",
    kindId: "codex",
    installationId: "local:codex:path",
    providerSessionId: "provider-private-1",
    workdir: "/Users/alice/private-project",
    processWitness: { state: "alive", pid: 4242, heartbeatAt: "2026-07-17T12:00:00.000Z" },
    attachable: { state: true, reason: "attach-channel-available" },
    clientBinding: { assertion: "client-asserted", taskId: "task-private", executionId: "exe-private" }
  };
  const service = makeAgentRuntimeService({
    kinds: [{ ...baseKind, kindId: "codex" }],
    discovery: fakeProbe({ path: async (kind) => found(kind.kindId, "path", "/Users/alice/.local/bin/codex") }),
    listSessions: async () => { reads += 1; return [session]; }
  });

  const first = await service.inventoryProjection();
  const second = await service.inventoryProjection();
  const serialized = JSON.stringify(first);

  assert.equal(reads, 2);
  assert.equal(first.rebuildable, true);
  assert.equal(second.rebuildable, true);
  for (const forbidden of ["/Users/alice", "provider-private", "task-private", "exe-private", "4242"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(/"[^"]*(?:credential|hash|rawPath|token)[^"]*"\s*:/iu.test(serialized), false);
});

function fakeProbe(overrides: Partial<AgentRuntimeDiscoveryProbe>): AgentRuntimeDiscoveryProbe {
  return {
    environmentOverride: async () => undefined,
    path: async () => undefined,
    loginShell: async () => [],
    appBundle: async () => undefined,
    verify: async () => ({ executable: true }),
    ...overrides
  };
}

function found(
  kindId: string,
  source: RuntimeExecutableCandidate["source"],
  executablePath = `/verified/${kindId}`
): RuntimeExecutableCandidate {
  return { kindId, source, executablePath };
}
