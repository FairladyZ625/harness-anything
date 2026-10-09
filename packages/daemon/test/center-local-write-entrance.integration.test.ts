// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
} from "./repo-settings.fixture.ts";
import { signInAt, signOutAt } from "./keycloak.fixtures.ts";
import { withPolicyGroup, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { definition, initHarnessRepo } from "./schedule-actions.fixtures.ts";

const operator = withPolicyGroup(
  { actor: { principal: { personId: "center-operator" }, executor: null }, source: "local" as const },
  "admin",
);

type Receipt = {
  readonly outcome: string;
  readonly code?: string;
  readonly revision?: number;
  readonly rejectionExplanation?: string | null;
  readonly packagePath?: string;
};

const schedule = (scheduleId: string) => ({
  kind: "schedule-create",
  scheduleId,
  name: scheduleId,
  mode: "detect",
  everyMs: 300_000,
  agentId: "probe-agent",
  mission: "Inspect the repository and report success.",
  idempotencyKey: `seed-${scheduleId}`,
});

const edgeNode = (_repoId: string, nodeId: string) => ({ nodeId });

async function openModes(prefix: string) {
  const parent = mkdtempSync(path.join(tmpdir(), prefix)),
    userRoot = path.join(parent, "user");
  for (const [repoId, mode] of [
    ["center", "remote-center"],
    ["edge", "remote-edge"],
  ] as const) {
    rosterRepo(path.join(parent, repoId), repoId);
    registerDaemonRepo({
      canonicalRoot: path.join(parent, repoId),
      repoId,
      mode,
      userRoot,
      createConvenienceLinks: false,
    });
  }
  signInPolicyTestUser(userRoot, "writer", ["center", "edge"], "admin");
  const host = await openDaemonHost({ daemonId: "center-entrance", userRoot });
  await host.attachmentsSettled();
  return { parent, host };
}

test("an authenticated center-local principal writes a remote-center ledger", async () => {
  const { parent, host } = await openModes("ha-center-entrance-");
  try {
    const run = (action: Readonly<Record<string, unknown>>) =>
      host.run("center", action as never, auth) as Promise<Receipt>;
    const created = await run({ kind: "task-create", taskId: "task-center-local", title: "Center local" });
    assert.equal(created.outcome, "applied", JSON.stringify(created));

    const scheduled = await run(schedule("center-probe"));
    assert.equal(scheduled.outcome, "applied", JSON.stringify(scheduled));

    await realizeTaskPlanFixture(path.join(parent, "center"), String(created.packagePath), (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }),
    );
    const started = await run({ kind: "task-start", taskId: "task-center-local", executionId: "exe-center-local" });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const progress = await run({
      kind: "task-progress-append",
      taskId: "task-center-local",
      text: "center wrote this",
    });
    assert.equal(progress.outcome, "applied", JSON.stringify(progress));
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the center admits no unauthenticated source and the edge admits no local ledger write", async () => {
  const { parent, host } = await openModes("ha-center-entrance-negative-");
  try {
    const stranger = {
      ...auth,
      unixSocketOwnerBoundary: { ...auth.unixSocketOwnerBoundary, ownerUid: (process.getuid?.() ?? 0) + 1_000 },
    };
    signOutAt(path.join(parent, "user"));
    const denied = (await host.run(
      "center",
      { kind: "task-create", taskId: "task-center-stranger", title: "Stranger" },
      stranger,
    )) as Receipt;
    assert.equal(denied.outcome, "op_rejected");
    assert.equal(denied.code, "authentication_required");

    // Repository registration does not sign the operator in.
    const bare = path.join(parent, "bare");
    initHarnessRepo(bare, "bare");
    registerDaemonRepo({
      canonicalRoot: bare,
      repoId: "bare",
      mode: "remote-center",
      userRoot: path.join(parent, "user"),
      createConvenienceLinks: false,
    });
    signInAt(path.join(parent, "user"), "writer");
    const refreshed = await host.requestControl({ kind: "refresh", authorityRepoId: "center" }, auth);
    for (let attempt = 0; host.status().repos.every(({ repoId }) => repoId !== "bare"); attempt++) {
      assert.ok(attempt < 200, `refresh ${refreshed.operationId} never attached the roster-free center`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await host.attachmentsSettled();
    signOutAt(path.join(parent, "user"));
    const unauthenticated = (await host.run(
      "bare",
      { kind: "task-create", taskId: "task-center-unauthenticated", title: "Unauthenticated" },
      auth,
    )) as Receipt;
    assert.equal(unauthenticated.outcome, "op_rejected");
    assert.equal(unauthenticated.code, "authentication_required");

    signInAt(path.join(parent, "user"), "writer");
    for (const action of [
      { kind: "task-create", taskId: "task-edge-local", title: "Edge local" },
      schedule("edge-probe"),
      { kind: "agent-install", packageSource: path.join(parent, "edge"), expectedVersion: 0 },
    ]) {
      const rejected = (await host.run("edge", action as never, auth)) as Receipt;
      assert.equal(rejected.outcome, "op_rejected", action.kind);
      assert.equal(rejected.code, "repo_mode_read_only", action.kind);
    }
    // Runtime-local execution still belongs to the node that holds the assignment.
    const runNow = (await host.run(
      "center",
      { kind: "schedule-run-now", scheduleId: "center-probe", idempotencyKey: "center-run-now" },
      auth,
    )) as Receipt;
    assert.equal(runNow.code, "repo_mode_requires_center_ingress");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the authorized Schedule creator and an operator write a remote-center cell", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-entrance-system-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initHarnessRepo(root, "center-system");
    appendFileSync(path.join(root, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [center-ci]\n");
    cell = await openRepoCell({
      repoId: workspaceId("center-system"),
      rootDir: canonicalRoot(root),
      ownerId: "center-system",
      mode: "remote-center",
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Center Codex",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
    });
    const created = (await cell.run(schedule("node-heartbeat-edge-one") as never, operator)) as Receipt;
    assert.equal(created.outcome, "applied", JSON.stringify(created));

    const packageSource = path.join(root, "source", "center-agent");
    mkdirSync(packageSource, { recursive: true });
    writeFileSync(
      path.join(packageSource, "agent.json"),
      `${JSON.stringify({
        schema: "agent-declaration/v1",
        id: "center-agent",
        name: "Center Agent",
        instructions: "Execute the assigned mission through the canonical action route.",
        runtimes: [{ type: definition.kindId }],
      })}\n`,
    );
    const installed = (await cell.run(
      { kind: "agent-install", packageSource, expectedVersion: 0, idempotencyKey: "center-agent-install" },
      operator,
    )) as Receipt;
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));

    const settings = (await cell.run(
      { kind: "settings-update", ciWorkflows: ["center-gates"], idempotencyKey: "center-settings" },
      operator,
    )) as Receipt;
    assert.equal(settings.outcome, "applied", JSON.stringify(settings));
    const reader = makeTaskEventReader({ repoId: workspaceId("center-system"), rootDir: canonicalRoot(root) });
    try {
      assert.deepEqual(
        reader
          .read()
          .events.filter((event) => event.schema === "schedule-event/v1")
          .map((event) => [event.type, event.actor.principal.personId, event.source]),
        [["schedule_created", "center-operator", "local"]],
      );
    } finally {
      await reader.drain();
    }
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a center-local write and an edge write race through one queue under expectedVersion", async () => {
  const { parent, host } = await openModes("ha-center-entrance-race-"),
    // The edge entrance speaks for the person its node is registered to at the center.
    owners = await fleetNodeOwners({
      userRoot: path.join(parent, "user"),
      owners: { "edge-one": "writer" },
      repoIds: ["center"],
    });
  try {
    const local = (action: Readonly<Record<string, unknown>>) =>
        host.run("center", action as never, auth) as Promise<Receipt>,
      edge = (action: Readonly<Record<string, unknown>>) =>
        host.run("center", action as never, owners.auth(edgeNode("center", "edge-one"))) as Promise<Receipt>;
    // Independent writes from both entrances serialize: each lands on its own revision.
    const [localCreate, edgeCreate] = await Promise.all([
      local({ kind: "task-create", taskId: "task-race-local", title: "Local" }),
      edge({ kind: "task-create", taskId: "task-race-edge", title: "Edge" }),
    ]);
    assert.equal(localCreate.outcome, "applied", JSON.stringify(localCreate));
    assert.equal(edgeCreate.outcome, "applied", JSON.stringify(edgeCreate));
    assert.notEqual(localCreate.revision, edgeCreate.revision);

    // The same CAS slot from both entrances has exactly one winner; the loser never overwrites it.
    for (const first of ["local", "edge"] as const) {
      const create = (mission: string) => ({ ...schedule(`race-${first}`), mission, idempotencyKey: mission }),
        contenders = { local: () => local(create("center asked")), edge: () => edge(create("edge asked")) },
        receipts = await Promise.all([contenders[first](), contenders[first === "local" ? "edge" : "local"]()]);
      assert.deepEqual(
        receipts.map(({ outcome, code }) => [outcome, code ?? null]).sort(),
        [
          ["applied", null],
          ["op_rejected", "entity_exists"],
        ],
        JSON.stringify(receipts),
      );
    }
    const version = (await local({ kind: "task-create", taskId: "task-race-cas", title: "CAS" })).revision,
      transitions = await Promise.all([
        local({ kind: "task-transition", taskId: "task-race-cas", status: "blocked", expectedVersion: version }),
        edge({
          kind: "task-transition",
          taskId: "task-race-cas",
          status: "cancelled",
          reason: "edge raced the center",
          expectedVersion: version,
        }),
      ]);
    // task-lifecycle/revisionIssues reports a stale expectedVersion as invalid_transition.
    assert.deepEqual(
      transitions.map(({ outcome, code }) => [outcome, code ?? null]).sort(),
      [
        ["applied", null],
        ["op_rejected", "invalid_transition"],
      ],
      JSON.stringify(transitions),
    );
    assert.match(
      String(transitions.find(({ outcome }) => outcome !== "applied")?.rejectionExplanation),
      /expectedVersion equals the canonical Task projection revision at commit time/u,
    );
    const reader = makeTaskEventReader({
      repoId: workspaceId("center"),
      rootDir: canonicalRoot(path.join(parent, "center")),
    });
    try {
      const events = reader.read().events,
        revisions = events.map((event) => event.workspaceRevision);
      assert.deepEqual(
        revisions,
        revisions.map((_, index) => index + 1),
        "the queue assigned one gapless revision per accepted write",
      );
      assert.equal(
        events.filter((event) => event.type === "schedule_created" && event.entity.id.startsWith("race-")).length,
        2,
      );
    } finally {
      await reader.drain();
    }
  } finally {
    await owners.close();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
