// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { prepareRuntimeInstance, resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";
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

test("repository allowlist filters automatic candidates and reports the blocked instance", () => {
  const instances = [
    instance("project-a", "codex", "provider-codex"),
    instance("project-b", "devin", "provider-devin"),
  ];
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({ agent: agent(), instances, sessions: [], allowedInstanceIds: ["project-a"] }),
    ["project-a"],
  );
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "project-b",
        agent: agent(),
        instances,
        sessions: [],
        allowedInstanceIds: ["project-a"],
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Runtime instance project-b is not allowed for this repository. Allowed instances: project-a. " +
          "Enable it with ha settings update --runtime-allowed-instance project-b.",
  );
});

test("an empty repository allowlist rejects every automatic dispatch with actionable guidance", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        agent: agent(),
        instances: [instance("machine-codex", "codex", "provider-codex")],
        sessions: [],
        allowedInstanceIds: [],
      }),
    (error: unknown) =>
      error instanceof Error &&
      /No runtime instance is allowed for this repository.*Allowed instances: none.*ha settings update --runtime-allowed-instance <instance-id>/u.test(
        error.message,
      ),
  );
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

test("all unavailable reports each declared runtime and local instance reason", () => {
  const disabled = { ...instance("codex-disabled", "codex", "provider-codex"), enabled: false };
  const signedOut = instance("devin-signed-out", "devin", "provider-devin", [], {
    status: "unavailable",
    code: "runtime_subscription_required",
    hint: "Sign in.",
  });
  assert.throws(
    () => resolveRuntimeInstanceCandidates({ agent: agent(), instances: [disabled, signedOut], sessions: [] }),
    (error: unknown) =>
      error instanceof Error &&
      /codex-disabled.*runtime_instance_disabled/u.test(error.message) &&
      /devin-signed-out.*runtime_subscription_required/u.test(error.message),
  );
});

for (const firstReady of [true, false]) {
  test(`prepare selects declared runtime order; first ready=${firstReady}`, async () => {
    const attempts: string[] = [];
    const selected = await prepareRuntimeInstance(
      {
        agent: agent(),
        instances: [instance("codex-first", "codex", "openai"), instance("devin-second", "devin", "devin")],
        sessions: [],
      },
      async (id) => {
        attempts.push(id);
        if (!firstReady && id === "codex-first")
          throw Object.assign(new Error("Sign in required"), { code: "runtime_subscription_required" });
        return { prepared: id };
      },
    );
    assert.equal(selected.instanceId, firstReady ? "codex-first" : "devin-second");
    assert.deepEqual(attempts, firstReady ? ["codex-first"] : ["codex-first", "devin-second"]);
  });
}

test("prepare exhaustion lists every attempted instance, and unknown errors propagate", async () => {
  const input = {
    agent: agent(),
    instances: [instance("codex-first", "codex", "openai"), instance("devin-second", "devin", "devin")],
    sessions: [],
  };
  await assert.rejects(
    prepareRuntimeInstance(input, async (id) => {
      throw Object.assign(new Error(`Missing ${id}`), { code: "runtime_installation_not_found" });
    }),
    /codex-first: runtime_installation_not_found.*devin-second: runtime_installation_not_found/u,
  );
  const error = Object.assign(new Error("Malformed launch"), { code: "invalid_runtime_launch" });
  let attempts = 0;
  await assert.rejects(
    prepareRuntimeInstance(input, async () => {
      attempts += 1;
      throw error;
    }),
    (observed) => observed === error,
  );
  assert.equal(attempts, 1);
});

for (const code of [
  "runtime_instance_not_found",
  "invalid_runtime_model",
  "runtime_subscription_required",
  "runtime_credential_unavailable",
]) {
  test(`pinned preparation preserves ${code} for explicit requests and resume`, async () => {
    const original = Object.assign(new Error(code), { code });
    for (const pin of [{ requested: "missing" }, { providerSessionId: "resume" }]) {
      await assert.rejects(
        prepareRuntimeInstance(
          {
            ...pin,
            agent: null,
            instances: [],
            sessions: [{ providerSessionId: "resume", instanceId: "missing" } as never],
          },
          async () => {
            throw original;
          },
        ),
        (observed) => observed === original,
      );
    }
  });
}
