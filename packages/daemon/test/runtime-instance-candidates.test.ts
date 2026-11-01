// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { prepareRuntimeInstance, resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";
import { readSettingsFacet } from "@harness-anything/kernel";
import { initialRuntimeInstanceSettings } from "../src/runtime-spawn-allowlist.ts";
import { locallyObservedRuntimeSessions } from "../src/runtime-spawn-adoption.ts";
import type { RuntimeAgent } from "../src/runtime-spawn-types.ts";
import {
  agentRuntimeAmbiguityWarning,
  runtimeInstanceModel,
  selectedRuntimeInstance,
} from "../src/runtime-instance-selection.ts";

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
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "devin-ready",
        explicitlyRequested: true,
        agent: agent(),
        model: "model-a",
        instances,
        sessions: [],
        allowedInstanceIds,
      }),
    (error: unknown) =>
      (error as { code?: string; message?: string }).code === "invalid_runtime_model" &&
      (error as { message?: string }).message?.includes("Supported models: model-b") === true,
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

test("prepare keeps the declared runtimes row order when an earlier row is busier", async () => {
  const attempts: string[] = [];
  const selected = await prepareRuntimeInstance(
    {
      agent: agent(),
      instances: [instance("devin-idle", "devin", "provider-devin"), instance("codex-busy", "codex", "provider-codex")],
      sessions: [
        { instanceId: "codex-busy", liveness: "live" } as never,
        { instanceId: "codex-busy", liveness: "live" } as never,
      ],
      allowedInstanceIds: ["codex-busy", "devin-idle"],
    },
    async (id) => {
      attempts.push(id);
      return { prepared: id };
    },
  );
  assert.equal(selected.instanceId, "codex-busy");
  assert.deepEqual(attempts, ["codex-busy"]);
});

test("prepare spreads live load across instances of one declared runtime row", async () => {
  const attempts: string[] = [];
  const selected = await prepareRuntimeInstance(
    {
      agent: { ...agent(), runtimes: [{ type: "codex" }] },
      instances: [instance("codex-b", "codex", "provider-codex"), instance("codex-a", "codex", "provider-codex")],
      // The live session sits on the instance the configured order puts first, so only the
      // live-load key can move the choice to its peer (an id tiebreak would also pick codex-a).
      sessions: [{ instanceId: "codex-a", liveness: "live" } as never],
      allowedInstanceIds: ["codex-a", "codex-b"],
    },
    async (id) => {
      attempts.push(id);
      return { prepared: id };
    },
  );
  assert.equal(selected.instanceId, "codex-b");
  assert.deepEqual(attempts, ["codex-b"]);
});

test("prepare counts a live local owner when canonical liveness is exited", async () => {
  const attempts: string[] = [],
    runtimeSessionId = "runtime-exited-canonical-live-local",
    sessions = locallyObservedRuntimeSessions(
      [
        {
          runtimeSessionId,
          providerSessionId: null,
          instanceId: "codex-a",
          liveness: "exited",
          outcome: null,
        },
      ],
      new Map([[runtimeSessionId, { process: { pid: process.pid } }]]),
    );
  const selected = await prepareRuntimeInstance(
    {
      agent: { ...agent(), runtimes: [{ type: "codex" }] },
      instances: [instance("codex-a", "codex", "provider-codex"), instance("codex-b", "codex", "provider-codex")],
      sessions,
      allowedInstanceIds: ["codex-a", "codex-b"],
    },
    async (id) => {
      attempts.push(id);
      return { prepared: id };
    },
  );
  assert.equal(sessions[0]!.liveness, "live");
  assert.equal(selected.instanceId, "codex-b");
  assert.deepEqual(attempts, ["codex-b"]);
});

test("prepare keeps the configured order on an equal-load tie inside one declared row", async () => {
  const attempts: string[] = [];
  const selected = await prepareRuntimeInstance(
    {
      agent: { ...agent(), runtimes: [{ type: "codex" }] },
      // The resolver lists codex-b before codex-a; an instance-id tiebreak would pick codex-a.
      instances: [instance("codex-b", "codex", "provider-codex"), instance("codex-a", "codex", "provider-codex")],
      sessions: [],
      allowedInstanceIds: ["codex-b", "codex-a"],
    },
    async (id) => {
      attempts.push(id);
      return { prepared: id };
    },
  );
  assert.equal(selected.instanceId, "codex-b");
  assert.deepEqual(attempts, ["codex-b"]);
});

test("prepare keeps the configured order for a dispatch that declares no runtimes", async () => {
  const attempts: string[] = [];
  const selected = await prepareRuntimeInstance(
    {
      agent: null,
      instances: [instance("codex-api", "codex", "provider-codex"), instance("zcode-glm", "zcode", "provider-zcode")],
      sessions: [],
      allowedInstanceIds: ["zcode-glm", "codex-api"],
    },
    async (id) => {
      attempts.push(id);
      return { prepared: id };
    },
  );
  assert.equal(selected.instanceId, "zcode-glm");
  assert.deepEqual(attempts, ["zcode-glm"]);
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

// An old CLI is a per-installation refusal, not a per-kind one: one node can witness two
// installations of the same kind, and automatic selection must reach the usable one. An
// explicit pin keeps the refusal, because it names that exact installation.
test("automatic selection retries past a below-floor CLI while an explicit pin keeps the refusal", async () => {
  const instances = [instance("claude-old", "claude", "anthropic"), instance("claude-current", "claude", "anthropic")],
    input = { agent: null, instances, sessions: [], allowedInstanceIds: instances.map((row) => row.instanceId) },
    belowFloor = () =>
      Object.assign(new Error("Claude Code 2.1.268 is below the supported minimum 2.1.280"), {
        code: "minimum_version_not_met",
      });
  const attempts: string[] = [];
  assert.deepEqual(
    await prepareRuntimeInstance(input, async (id) => {
      attempts.push(id);
      if (id === "claude-old") throw belowFloor();
      return { prepared: id };
    }),
    { instanceId: "claude-current", launch: { prepared: "claude-current" } },
  );
  assert.deepEqual(attempts, ["claude-old", "claude-current"]);

  const pinned = belowFloor();
  await assert.rejects(
    prepareRuntimeInstance({ ...input, requested: "claude-old" }, async () => {
      throw pinned;
    }),
    (observed) => observed === pinned,
  );
});

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

test("a declaration instance pin that cannot serve the override model reports the declaration-level error", () => {
  const pinned = instance("codex-pinned", "codex", "provider-codex", ["other-model"]),
    other = instance("codex-other", "codex", "provider-codex", ["other-model"]),
    declared: RuntimeAgent = { ...agent(), runtimes: [{ type: "codex" }], instance: "codex-pinned" };
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "codex-pinned",
        agent: declared,
        model: "missing-model",
        instances: [pinned, other],
        sessions: [],
        allowedInstanceIds: ["codex-pinned", "codex-other"],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code: string }).code === "agent_model_unavailable" &&
      error.message.includes("No enabled runtime instance declares model missing-model"),
  );
});

test("a disabled declaration instance pin reports the declared runtime kind, not the store error", () => {
  const pinned = { ...instance("agy-pinned", "agy", "provider-agy", ["agy-model"]), enabled: false } as never,
    other = instance("codex-other", "codex", "provider-codex", ["codex-model"]),
    declared: RuntimeAgent = { ...agent(), runtimes: [{ type: "agy" }], instance: "agy-pinned" };
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "agy-pinned",
        agent: declared,
        instances: [pinned, other],
        sessions: [],
        allowedInstanceIds: ["agy-pinned", "codex-other"],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code: string }).code === "agent_runtime_unavailable" &&
      error.message ===
        "Agent multi-runtime requires agy, but no enabled instance of those runtime kinds is available on this node. " +
          "Candidates: agy: runtime_instance_not_found (no local instance)",
  );
});

test("an explicit instance request keeps the hard pin when that instance is disabled", () => {
  const pinned = { ...instance("codex-pinned", "codex", "provider-codex", ["other-model"]), enabled: false } as never;
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      requested: "codex-pinned",
      agent: agent(),
      instances: [pinned],
      sessions: [],
      allowedInstanceIds: ["codex-pinned"],
    }),
    ["codex-pinned"],
  );
});

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

const sol = (): RuntimeAgent => ({
  id: "sol",
  name: "Sol",
  instructions: "Run the mission.",
  runtimes: [{ type: "codex", model: "gpt-6.1-sol" }],
});

const splitInstances = () => [
  instance("codex-api", "codex", "provider-codex", ["gpt-6.1-sol"]),
  instance("zcode-flash", "zcode", "provider-zcode", ["GLM-5.3-Flash"]),
];

test("an explicit instance pin of an undeclared runtime kind is rejected for a declaring Agent", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "zcode-flash",
        agent: sol(),
        instances: splitInstances(),
        sessions: [],
        allowedInstanceIds: ["codex-api", "zcode-flash"],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "agent_runtime_unavailable" &&
      /declares codex.*zcode-flash.*zcode instance/u.test(error.message),
  );
});

test("a resumed provider session on an undeclared runtime kind is rejected for a declaring Agent", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        providerSessionId: "drifted-session",
        agent: sol(),
        instances: splitInstances(),
        sessions: [{ providerSessionId: "drifted-session", instanceId: "zcode-flash" } as never],
        allowedInstanceIds: ["codex-api", "zcode-flash"],
      }),
    (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === "agent_runtime_unavailable",
  );
});

test("a declared-kind pin and resume keep the requested instance", () => {
  const instances = splitInstances();
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      requested: "codex-api",
      agent: sol(),
      instances,
      sessions: [],
      allowedInstanceIds: ["codex-api", "zcode-flash"],
    }),
    ["codex-api"],
  );
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      providerSessionId: "worker-session",
      agent: sol(),
      instances,
      sessions: [{ providerSessionId: "worker-session", instanceId: "codex-api" } as never],
      allowedInstanceIds: ["codex-api", "zcode-flash"],
    }),
    ["codex-api"],
  );
});

test("an Agent without runtime declarations keeps every explicit pin and resume", () => {
  const instances = splitInstances();
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      requested: "zcode-flash",
      agent: { id: "observer", name: "Observer", instructions: "Observe.", runtimes: [] },
      instances,
      sessions: [],
      allowedInstanceIds: ["codex-api", "zcode-flash"],
    }),
    ["zcode-flash"],
  );
});

// The deli-ai-lab shape: two deepseek-harness instances, one publishing the model title-cased
// and one lower-cased, and a declaration that writes the lower-case spelling.
const deepseekInstance = (instanceId: string, models: readonly string[]): never =>
  instance(instanceId, "deepseek-harness", `provider-${instanceId}`, models) as never;
const deepseekReviewer = (extra: Record<string, unknown> = {}): RuntimeAgent => ({
  id: "lab-glm-reviewer",
  name: "Lab reviewer",
  instructions: "Review.",
  runtimes: [{ type: "deepseek-harness", model: "deepseek-v4.1-flash" }],
  ...extra,
});

test("an exact model spelling outranks a case-insensitive one whatever the allowlist order", () => {
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]),
    ],
    agent = deepseekReviewer();
  for (const allowedInstanceIds of [
    ["ds-bailian", "ds-harness-api"],
    ["ds-harness-api", "ds-bailian"],
  ]) {
    assert.deepEqual(resolveRuntimeInstanceCandidates({ agent, instances, sessions: [], allowedInstanceIds }), [
      "ds-bailian",
      "ds-harness-api",
    ]);
  }
});

test("a case-insensitive catalog spelling is compatible instead of agent_model_unavailable", () => {
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: deepseekReviewer(),
      instances: [deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"])],
      sessions: [],
      allowedInstanceIds: ["ds-harness-api"],
    }),
    ["ds-harness-api"],
  );
});

test("provider/model declarations retain exact-match priority after extracting the catalog model", () => {
  const declared: RuntimeAgent = {
      ...agent(),
      runtimes: [{ type: "codex", model: '["openai","GPT-6.1-Astra"]' }],
    },
    instances = [
      instance("codex-casefold", "codex", "openai", ["gpt-6.1-astra"]),
      instance("codex-exact", "codex", "openai", ["GPT-6.1-Astra"]),
    ];
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: declared,
      instances,
      sessions: [],
      allowedInstanceIds: ["codex-casefold", "codex-exact"],
    }),
    ["codex-exact", "codex-casefold"],
  );
});

test("an exact provider/model catalog id is preserved before extracting its model", () => {
  const tuple = '["deepseek-official","Deepseek-V4.1-Flash"]',
    catalog = instance("deepseek-tuple", "deepseek-harness", "deepseek", [tuple]);
  assert.equal(runtimeInstanceModel([catalog], "deepseek-tuple", tuple), tuple);
});

test("model compatibility rejects catalogs without an exact or case-insensitive match", () => {
  const declared: RuntimeAgent = { ...agent(), runtimes: [{ type: "codex", model: "gpt-6.1-astra" }] };
  for (const models of [["claude-sonnet"], ["gpt-5.6-sol"], ["gpt-5.6-sol", "gpt-5.6-terra"]])
    assert.throws(
      () =>
        resolveRuntimeInstanceCandidates({
          agent: declared,
          instances: [instance("codex-no-match", "codex", "openai", models)],
          sessions: [],
          allowedInstanceIds: ["codex-no-match"],
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { readonly code?: string }).code === "agent_model_unavailable" &&
        error.message.includes("No enabled runtime instance declares model gpt-6.1-astra"),
    );
});

test("an explicit instance with no matching model fails before launch preparation", () => {
  const declared = deepseekReviewer(),
    available = instance("ds-bailian", "deepseek-harness", "deepseek", ["gpt-5.6-sol"]);
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "ds-bailian",
        agent: declared,
        instances: [available],
        sessions: [],
        allowedInstanceIds: ["ds-bailian"],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { readonly code?: string }).code === "invalid_runtime_model" &&
      error.message.includes("Supported models: gpt-5.6-sol") &&
      error.message.includes("Use --model <supported-model>") &&
      error.message.includes("--instance <instance-id>"),
  );
});

test("preferredInstances orders same-row candidates ahead of the model tier and allowlist", () => {
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]),
    ],
    agent = deepseekReviewer({ preferredInstances: ["ds-harness-api"] });
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent,
      instances,
      sessions: [],
      allowedInstanceIds: ["ds-bailian", "ds-harness-api"],
    }),
    ["ds-harness-api", "ds-bailian"],
  );
});

test("a soft preference yields to availability and never blocks dispatch", async () => {
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]),
    ],
    agent = deepseekReviewer({ preferredInstances: ["ds-harness-api"] }),
    selected = await prepareRuntimeInstance(
      { agent, instances, sessions: [], allowedInstanceIds: ["ds-bailian", "ds-harness-api"] },
      async (instanceId) => {
        if (instanceId === "ds-harness-api")
          throw Object.assign(new Error("Sign in"), { code: "runtime_subscription_required" });
        return { prepared: instanceId };
      },
    );
  assert.equal(selected.instanceId, "ds-bailian");
});

test("selection is identical across repeated runs for the two-casing node", async () => {
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]),
    ],
    agent = deepseekReviewer(),
    runs: string[] = [];
  for (let run = 0; run < 5; run += 1)
    runs.push(
      (
        await prepareRuntimeInstance(
          { agent, instances, sessions: [], allowedInstanceIds: ["ds-harness-api", "ds-bailian"] },
          async (instanceId) => ({ prepared: instanceId }),
        )
      ).instanceId,
    );
  assert.deepEqual(runs, ["ds-bailian", "ds-bailian", "ds-bailian", "ds-bailian", "ds-bailian"]);
});

test("the selection reason names the rule that decided and the spelling to launch", () => {
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]),
    ],
    agent = deepseekReviewer(),
    exact = selectedRuntimeInstance({ agent, instances, selected: "ds-bailian" }),
    variant = selectedRuntimeInstance({ agent, instances, selected: "ds-harness-api" });
  assert.equal(exact.basis, "exact-model");
  assert.equal(exact.model, "deepseek-v4.1-flash");
  assert.match(exact.reason, /lists the declared model deepseek-v4\.1-flash verbatim/u);
  assert.equal(variant.basis, "case-insensitive-model");
  // The launch keeps the catalog's spelling: the instance store validates membership verbatim.
  assert.equal(variant.model, "Deepseek-V4.1-Flash");
  assert.match(variant.reason, /only with different letter case/u);
});

test("the selection reason reports an explicit request, a pin, and a declared preference", () => {
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]),
    ],
    agent = deepseekReviewer({ preferredInstances: ["ds-harness-api"] });
  assert.equal(
    selectedRuntimeInstance({ agent: null, instances, selected: "ds-harness-api", explicitlyRequested: true }).basis,
    "explicit-request",
  );
  assert.equal(
    selectedRuntimeInstance({ agent: { ...agent, instance: "ds-bailian" }, instances, selected: "ds-bailian" }).basis,
    "declared-instance",
  );
  assert.equal(selectedRuntimeInstance({ agent, instances, selected: "ds-harness-api" }).basis, "declared-preference");
  assert.equal(selectedRuntimeInstance({ agent: null, instances, selected: "ds-bailian" }).basis, "runtime-row-order");
});

test("an explicit instance receipt records the declaration-to-catalog model resolution", () => {
  const agent = deepseekReviewer(),
    instances = [deepseekInstance("ds-bailian", ["Deepseek-V4.1-Flash"])],
    selection = selectedRuntimeInstance({
      agent,
      instances,
      selected: "ds-bailian",
      explicitlyRequested: true,
    });
  assert.equal(selection.model, "Deepseek-V4.1-Flash");
  assert.match(
    selection.reason,
    /Agent lab-glm-reviewer declares model deepseek-v4\.1-flash, which resolves to Deepseek-V4\.1-Flash on instance ds-bailian/u,
  );
});

test("ambiguity warns while a pin or an exhaustive preference stays silent", () => {
  const runtimeInstances = [
      { ...deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]) },
      { ...deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]) },
    ],
    agent = deepseekReviewer(),
    warning = agentRuntimeAmbiguityWarning({ agent, runtimeInstances });
  assert.equal(warning?.code, "agent_runtime_instance_ambiguous");
  assert.match(warning!.message, /ds-bailian, ds-harness-api|ds-harness-api, ds-bailian/u);
  assert.match(warning!.message, /preferredInstances/u);
  // One hard pin removes the choice.
  assert.equal(agentRuntimeAmbiguityWarning({ agent: { ...agent, instance: "ds-bailian" }, runtimeInstances }), null);
  // A preference list that leaves only one unpreferred candidate still states the winner.
  assert.equal(
    agentRuntimeAmbiguityWarning({ agent: { ...agent, preferredInstances: ["ds-bailian"] }, runtimeInstances }),
    null,
  );
  // A single compatible instance is not ambiguous.
  assert.equal(agentRuntimeAmbiguityWarning({ agent, runtimeInstances: [runtimeInstances[0]!] }), null);
});

test("a tie on the model tier names the real deciding key instead of claiming the tier", () => {
  // Every compatible instance spells the model identically, so the model tier separates nothing
  // and the receipt must not credit it: load and allowed-instance order are what decided.
  const instances = [
      deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]),
      deepseekInstance("ds-backup", ["deepseek-v4.1-flash"]),
    ],
    tied = selectedRuntimeInstance({ agent: deepseekReviewer(), instances, selected: "ds-backup" });
  assert.equal(tied.basis, "runtime-row-order");
  assert.match(tied.reason, /model spelling did not separate the candidates/u);
  assert.doesNotMatch(tied.reason, /ranks ahead of any instance/u);
});

test("a dispatch-time ambiguity warning names the instance it took, not a hypothetical fallback", () => {
  const runtimeInstances = [
      { ...deepseekInstance("ds-bailian", ["deepseek-v4.1-flash"]) },
      { ...deepseekInstance("ds-harness-api", ["Deepseek-V4.1-Flash"]) },
    ],
    agent = deepseekReviewer(),
    atDispatch = agentRuntimeAmbiguityWarning({ agent, runtimeInstances, selected: "ds-bailian" }),
    beforeDispatch = agentRuntimeAmbiguityWarning({ agent, runtimeInstances });
  assert.equal(atDispatch?.code, "agent_runtime_instance_ambiguous");
  // Dispatch already decided: it reports the instance, never "would fall back".
  assert.match(atDispatch!.message, /this dispatch took ds-bailian/u);
  assert.doesNotMatch(atDispatch!.message, /would fall back/u);
  // Validate/install run before any dispatch and keep the predictive wording.
  assert.match(beforeDispatch!.message, /dispatch would fall back/u);
  // Both still name the same candidates and both ways to state the intent.
  for (const warning of [atDispatch!, beforeDispatch!]) {
    assert.match(warning.message, /ds-bailian/u);
    assert.match(warning.message, /ds-harness-api/u);
    assert.match(warning.message, /preferredInstances/u);
  }
});
