// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";
import type { RuntimeAgent } from "../src/runtime-spawn-types.ts";

const instance = (
  instanceId: string,
  kindId: string,
  providerId: string,
  models: readonly string[] = [],
  authReadiness: { readonly status: string; readonly code: string | null; readonly hint: string | null } = {
    status: "ready",
    code: null,
    hint: null,
  },
) =>
  ({
    instanceId,
    kindId,
    providerId,
    models,
    enabled: true,
    authReadiness,
  }) as never;

const agent = (providerPriority?: readonly string[]): RuntimeAgent => ({
  id: "multi-runtime",
  name: "Multi Runtime",
  instructions: "Run the mission.",
  runtimes: [{ type: "codex" }, { type: "devin" }],
  fallback:
    providerPriority === undefined
      ? { backoff: { baseMs: 1, maxMs: 2 } }
      : { providerPriority, backoff: { baseMs: 1, maxMs: 2 } },
});

test("runtime candidates use runtimes row order only when providerPriority is absent", () => {
  const instances = [
    instance("aaa-devin", "devin", "provider-devin"),
    instance("zzz-codex", "codex", "provider-codex"),
  ];

  assert.deepEqual(resolveRuntimeInstanceCandidates({ agent: agent(), instances, sessions: [] }), [
    "zzz-codex",
    "aaa-devin",
  ]);
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: agent(["provider-devin", "provider-codex"]),
      instances,
      sessions: [],
    }),
    ["aaa-devin", "zzz-codex"],
  );
  assert.deepEqual(resolveRuntimeInstanceCandidates({ agent: agent([]), instances, sessions: [] }), [
    "aaa-devin",
    "zzz-codex",
  ]);
});

test("runtime candidates retain live-load and instance-id ordering within one runtime kind", () => {
  const instances = [
    instance("codex-b", "codex", "provider-b"),
    instance("codex-a", "codex", "provider-a"),
    instance("devin-a", "devin", "provider-devin"),
  ];

  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: agent(),
      instances,
      sessions: [{ instanceId: "codex-a", liveness: "live" } as never],
    }),
    ["codex-b", "codex-a", "devin-a"],
  );
});

test("runtime row ranking retains explicit instance, model, and auth filtering", () => {
  const instances = [
    instance("codex-unready", "codex", "provider-codex", ["model-a"], {
      status: "unavailable",
      code: "runtime_credential_unavailable",
      hint: "Log in.",
    }),
    instance("codex-ready", "codex", "provider-codex", ["model-a"]),
    instance("devin-ready", "devin", "provider-devin", ["model-b"]),
  ];

  assert.deepEqual(resolveRuntimeInstanceCandidates({ agent: agent(), model: "model-a", instances, sessions: [] }), [
    "codex-ready",
  ]);
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      requested: "devin-ready",
      agent: agent(),
      model: "model-a",
      instances,
      sessions: [],
    }),
    ["devin-ready"],
  );
});
