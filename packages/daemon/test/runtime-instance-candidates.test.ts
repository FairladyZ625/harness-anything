// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { prepareRuntimeInstance, resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";
import { readSettingsFacet } from "@harness-anything/kernel";
import { initialRuntimeInstanceSettings } from "../src/runtime-spawn-allowlist.ts";
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

const agent = (): RuntimeAgent => ({
  id: "multi-runtime",
  name: "Multi Runtime",
  instructions: "Run the mission.",
  runtimes: [{ type: "codex" }, { type: "devin" }],
});

test("runtime candidates use runtimes row order then project allowlist order", () => {
  const instances = [
      instance("aaa-devin", "devin", "provider-devin"),
      instance("zzz-codex", "codex", "provider-codex"),
    ],
    allowedInstanceIds = instances.map((row) => row.instanceId);

  assert.deepEqual(resolveRuntimeInstanceCandidates({ agent: agent(), instances, sessions: [], allowedInstanceIds }), [
    "zzz-codex",
    "aaa-devin",
  ]);
  assert.deepEqual(resolveRuntimeInstanceCandidates({ agent: agent(), instances, sessions: [], allowedInstanceIds }), [
    "zzz-codex",
    "aaa-devin",
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
          "Enable it without replacing the existing allowlist with ha settings update " +
          "--runtime-allowed-instance project-a --runtime-allowed-instance project-b.",
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

test("an uninitialized repository allowlist never falls back to machine-enabled instances", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "machine-codex",
        agent: null,
        instances: [instance("machine-codex", "codex", "provider-codex")],
        sessions: [],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "runtime_instance_allowlist_uninitialized" &&
      /ha init|repository settings/u.test(error.message),
  );
});

test("runtime candidates retain project list ordering within one runtime kind regardless of live load", () => {
  const instances = [
      instance("codex-b", "codex", "provider-b"),
      instance("codex-a", "codex", "provider-a"),
      instance("devin-a", "devin", "provider-devin"),
    ],
    allowedInstanceIds = ["codex-a", "codex-b", "devin-a"];

  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: agent(),
      instances,
      sessions: [{ instanceId: "codex-a", liveness: "live" } as never],
      allowedInstanceIds,
    }),
    ["codex-a", "codex-b", "devin-a"],
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
    ],
    allowedInstanceIds = instances.map((row) => row.instanceId);

  assert.deepEqual(
    resolveRuntimeInstanceCandidates({ agent: agent(), model: "model-a", instances, sessions: [], allowedInstanceIds }),
    ["codex-ready"],
  );
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      requested: "devin-ready",
      agent: agent(),
      model: "model-a",
      instances,
      sessions: [],
      allowedInstanceIds,
    }),
    ["devin-ready"],
  );
});

test("runtime candidates skip a locally cooling instance and report its recovery time", () => {
  const instances = [instance("codex-a", "codex", "provider-codex"), instance("codex-b", "codex", "provider-codex")],
    reasons: string[] = [],
    candidates = resolveRuntimeInstanceCandidates({
      agent: { ...agent(), runtimes: [{ type: "codex" }] },
      instances,
      sessions: [],
      allowedInstanceIds: ["codex-a", "codex-b"],
      now: "2026-10-12T00:00:00.000Z",
      health: [
        {
          instanceId: "codex-a",
          failureStreak: 1,
          cooldownUntil: "2026-10-12T00:00:30.000Z",
          frozenUntil: null,
          frozen: false,
          reason: "HTTP 429",
          lastFailureAt: "2026-10-12T00:00:00.000Z",
          lastResetAt: null,
        },
      ],
      unavailableReasons: reasons,
    });
  assert.deepEqual(candidates, ["codex-b"]);
  assert.match(reasons.join(";"), /codex-a.*recover at 2026-10-12T00:00:30.000Z/u);
});

test("all unavailable reports each declared runtime and local instance reason", () => {
  const disabled = { ...instance("codex-disabled", "codex", "provider-codex"), enabled: false };
  const signedOut = instance("devin-signed-out", "devin", "provider-devin", [], {
    status: "unavailable",
    code: "runtime_subscription_required",
    hint: "Sign in.",
  });
  const instances = [disabled, signedOut];
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        agent: agent(),
        instances,
        sessions: [],
        allowedInstanceIds: instances.map((row) => row.instanceId),
      }),
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
        allowedInstanceIds: ["codex-first", "devin-second"],
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
    allowedInstanceIds: ["codex-first", "devin-second"],
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
            allowedInstanceIds: ["missing"],
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

test("unknown explicit instances keep their machine-catalog error instead of a repository rejection", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "missing-instance",
        agent: null,
        instances: [instance("known-codex", "codex", "provider-codex")],
        sessions: [],
        allowedInstanceIds: ["known-codex"],
      }),
    (error: unknown) =>
      error instanceof Error && (error as Error & { code: string }).code === "runtime_instance_not_found",
  );
});

test("repository init seeds enabled instances once and preserves explicit project choices", () => {
  const settings = readSettingsFacet("layout:\n  authoredRoot: harness\n"),
    machines = [
      { instanceId: "codex-api", enabled: true },
      { instanceId: "other", enabled: false },
    ],
    projectA = initialRuntimeInstanceSettings(settings, machines),
    projectB = initialRuntimeInstanceSettings(settings, []);
  assert.deepEqual(projectA.runtime?.allowedInstances, ["codex-api"]);
  assert.deepEqual(projectB.runtime?.allowedInstances, []);
  assert.equal(initialRuntimeInstanceSettings(projectB, machines), projectB);
  assert.equal(initialRuntimeInstanceSettings(projectA, []), projectA);
  assert.equal(settings.runtime?.allowedInstances, undefined);
});
