// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import type { ResidentCeoDelegationProposal } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { eventuallyValue, initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { evidence } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

function writeProposalCodexStub(parent: string, responses: readonly string[]): string {
  const statePath = path.join(parent, "codex-supersede-turns.json");
  writeFileSync(statePath, JSON.stringify({ turn: 0, responses }));
  return writeProviderExecutable(
    path.join(parent, "codex.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
if (!(process.argv[2] === "exec" && process.argv.includes("--json"))) process.exit(9);
const prompt = readFileSync(0, "utf8");
const isPeerPrompt = prompt.includes("The following is a delegation message from a peer.") || prompt.includes("The following is a message from a peer.");
const statePath = ${JSON.stringify(statePath)};
let text = "worker runtime completed";
if (isPeerPrompt) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  text = state.responses[Math.min(state.turn, state.responses.length - 1)] ?? "fallback advisory response";
  state.turn += 1;
  writeFileSync(statePath, JSON.stringify(state));
}
const lines = [
  { type: "thread.started", thread_id: isPeerPrompt ? "ceo-supersede-session" : "worker-supersede-session" },
  { type: "item.completed", item: { id: "msg", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
];
lines.forEach((line, index) => setTimeout(() => console.log(JSON.stringify(line)), index * 20));
`,
  );
}

async function createWorkRoot(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  userRoot: string,
  repoId: string,
  workId: string,
  title: string,
  callerAuth: typeof auth,
) {
  const migrated = await host.run(repoId, { kind: "vertical-declaration-migrate" }, callerAuth);
  assert.ok(migrated.outcome === "applied" || migrated.outcome === "no_changes", JSON.stringify(migrated));
  const proposed = await host.run(
    repoId,
    {
      kind: "decision-propose",
      jsonInput: JSON.stringify({
        title: `Work decision for ${workId}`,
        question: `Authorize ${workId}?`,
        riskTier: "low",
        urgency: "low",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Proceed" }],
        rejected: [{ id: "RJ1", text: "Defer", whyNot: "Needed for test" }],
        claims: [],
        fulfillments: [],
      }),
      body: `# Work decision for ${workId}\n\n## 背景\n\nAuthorize test work root.\n\n## 权衡\n\nNeeded for Resident CEO supersede integration test.\n\n## 结论\n\nProceed.\n`,
    },
    callerAuth,
  );
  assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
  const decisionId =
    (evidence(proposed) as { decisionId?: string; decision?: { decisionId: string } }).decisionId ??
    (evidence(proposed) as { decision?: { decisionId: string } }).decision?.decisionId;
  assert.ok(decisionId, JSON.stringify(proposed));
  signInPolicyTestUser(userRoot, "person_arbiter", [repoId], "admin");
  const arbiterAuth = {
    ...auth,
    oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
  };
  const accepted = await host.run(
    repoId,
    { kind: "decision-accept", decisionId, rationale: "Approved", judgmentOnlyRationale: "Test work root" },
    arbiterAuth,
  );
  assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
  const work = await host.run(
    repoId,
    {
      kind: "task-create",
      taskId: workId,
      title,
      taskClass: "work",
      decisionRef: decisionId,
    },
    callerAuth,
  );
  assert.equal(work.outcome, "applied", JSON.stringify(work));
}

test(
  "Part A: resident CEO supersedesTaskId cancels unleased superseded task (freeing WIP before dispatch), supports --supersedes override, and refuses active held leases",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-supersede-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-supersede";
    const installation = {
      installationId: "ceo-supersede-codex",
      kindId: "codex" as const,
      executablePath: writeProposalCodexStub(parent, [
        JSON.stringify({
          action: "propose_task",
          title: "Replacement PR 1B",
          workId: "task_ceo_sup_work",
          agentId: "delegated-worker",
          supersedesTaskId: "task_sup_old_unleased",
          prompt: "Execute replacement PR 1B.",
          rationale: "Supersedes stale unleased task_sup_old_unleased.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Replacement via CLI --supersedes override",
          workId: "task_ceo_sup_work",
          agentId: "delegated-worker",
          prompt: "Owner supplies --supersedes at approval.",
          rationale: "Override supersedes target on approve.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Attempt to supersede active held task",
          workId: "task_ceo_sup_work",
          agentId: "delegated-worker",
          supersedesTaskId: "task_sup_old_live_lease",
          prompt: "Must not kill live lease.",
          rationale: "Negative control for active held lease.",
        }),
      ]),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      runtimeDiscover: () => [installation],
    });
    t.after(async () => {
      await host.close();
      removeTempRepository(parent);
    });
    await host.attachmentsSettled();
    await registerFixtureRuntimeInstance(host, repoId, auth, {
      instanceId: "codex-provider",
      name: "Resident CEO Supersede fixture",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["test-model"],
      authMode: "subscription",
      codex: {},
    });

    const bobAuth = {
      ...auth,
      oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
    };
    await createWorkRoot(host, userRoot, repoId, "task_ceo_sup_work", "Resident CEO Supersede Work", bobAuth);
    const installed = await host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "delegated-worker",
          name: "Delegated Worker",
          instructions: "Execute approved delegated tasks.",
          runtimes: [{ type: "codex" }],
        },
        expectedVersion: 0,
        idempotencyKey: "install-delegated-worker-supersede",
      },
      bobAuth,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));

    // Create two old active tasks: one unleased (with historical execution) and one with an active held lease.
    const createActiveTask = async (taskId: string, title: string, releaseAfterStart: boolean) => {
      const created = await host.run(
        repoId,
        { kind: "task-create", taskId, title, parentTaskId: "task_ceo_sup_work" },
        bobAuth,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await host.settleMaterialization(repoId, `materialize ${taskId}`);
      await realizeTaskPlanFixture(
        rootDir,
        String(created.packagePath),
        (planPath) => host.run(repoId, { kind: "doc-submit", paths: [planPath] }, bobAuth),
        title,
      );
      const started = await host.run(repoId, { kind: "task-start", taskId }, bobAuth);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      if (releaseAfterStart) {
        const released = await host.run(repoId, { kind: "task-release", taskId, reason: "Paused old run" }, bobAuth);
        assert.equal(released.outcome, "applied", JSON.stringify(released));
      }
    };

    await createActiveTask("task_sup_old_unleased", "Stale unleased PR 1A", true);
    await createActiveTask("task_sup_old_override", "Stale override target", true);
    await createActiveTask("task_sup_old_live_lease", "Active held lease task", false);

    // Tighten wipLimit to 3 (currently 3/3 occupied!) to prove supersedesTaskId frees WIP BEFORE starting replacement.
    const setWip = await host.run(
      repoId,
      { kind: "settings-update", wipLimit: 3, idempotencyKey: "ceo-supersede-wip-3" },
      bobAuth,
    );
    assert.equal(setWip.outcome, "applied", JSON.stringify(setWip));

    const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
      rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });
    assert.equal(
      (
        await ceo("config", {
          runtimeInstanceId: "codex-provider",
          model: "test-model",
          heartbeatIntervalSec: 300,
          executionPolicy: "approval-gated",
          defaultWorkId: "task_ceo_sup_work",
          defaultAgentId: "delegated-worker",
        })
      ).ok,
      true,
    );

    const sendDelegation = async (summary: string): Promise<ResidentCeoDelegationProposal> => {
      assert.equal((await ceo("stop")).ok, true);
      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const delegated = await host.run(
        repoId,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary },
        aliceAuth,
      );
      assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
      const { request } = evidence(delegated) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      assert.equal((await ceo("start")).ok, true);
      return eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "pending_approval" });
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        return items.find((entry) => entry.peerRequestId === request.requestId) ?? null;
      }, `pending proposal for ${summary}`);
    };

    // (1) Proposal specifying supersedesTaskId atomically cancels task_sup_old_unleased (with historical execution), freeing WIP so the new task starts under 3/3 limit!
    const p1 = await sendDelegation("Replace stale PR 1A");
    assert.equal(p1.proposedSupersedesTaskId, "task_sup_old_unleased");
    const approved1 = await ceo("approve", { proposalId: p1.proposalId });
    assert.equal(approved1.ok, true, JSON.stringify(approved1));
    assert.equal(approved1.supersededTaskId, "task_sup_old_unleased");
    assert.equal(approved1.supersedeError, null);
    const r1 = approved1.proposal as ResidentCeoDelegationProposal;
    assert.equal(r1.status, "promoted");
    assert.equal(r1.supersededTaskId, "task_sup_old_unleased");
    assert.equal(r1.supersedeError, null);
    assert.equal(r1.dispatchError, null, JSON.stringify(r1));
    assert.ok(r1.dispatchRuntimeSessionId, "new task should start and dispatch after WIP was freed");

    const old1 = evidence(await host.run(repoId, { kind: "task-show", taskId: "task_sup_old_unleased" }, bobAuth)) as {
      task: { readonly status: string };
    };
    assert.equal(old1.task.status, "cancelled", "old unleased task must be atomically cancelled");

    // (2) ha ceo approve --supersedes <taskId> override cancels task_sup_old_override and starts replacement under tight 3/3 WIP.
    const p2 = await sendDelegation("Replace via approve --supersedes");
    assert.equal(p2.proposedSupersedesTaskId, null);
    const approved2 = await ceo("approve", { proposalId: p2.proposalId, supersedesTaskId: "task_sup_old_override" });
    assert.equal(approved2.ok, true, JSON.stringify(approved2));
    assert.equal(approved2.supersededTaskId, "task_sup_old_override");
    assert.equal(approved2.supersedeError, null);
    const old2 = evidence(await host.run(repoId, { kind: "task-show", taskId: "task_sup_old_override" }, bobAuth)) as {
      task: { readonly status: string };
    };
    assert.equal(old2.task.status, "cancelled");

    // (3) Negative control: old task holds an active unexpired `held` lease -> MUST NOT cancel or kill lease, MUST surface supersedeError!
    const p3 = await sendDelegation("Attempt supersede on active held lease");
    assert.equal(p3.proposedSupersedesTaskId, "task_sup_old_live_lease");
    const approved3 = await ceo("approve", { proposalId: p3.proposalId });
    assert.equal(approved3.ok, true, JSON.stringify(approved3));
    assert.equal(approved3.supersededTaskId, null);
    assert.match(String(approved3.supersedeError ?? ""), /active held lease/u);
    const r3 = approved3.proposal as ResidentCeoDelegationProposal;
    assert.equal(r3.supersededTaskId, null);
    assert.match(r3.supersedeError ?? "", /active held lease/u);

    const liveStillActive = evidence(
      await host.run(repoId, { kind: "task-show", taskId: "task_sup_old_live_lease" }, bobAuth),
    ) as { task: { readonly status: string }; lease: { readonly phase: string } | null };
    assert.equal(liveStillActive.task.status, "active", "active leased task must remain active");
    assert.equal(liveStillActive.lease?.phase, "held", "active held lease must remain untouched");
  },
);
