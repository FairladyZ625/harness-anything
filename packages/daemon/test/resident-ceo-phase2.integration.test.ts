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

function writeProposalCodexStub(parent: string, responses: readonly string[]): string {
  const statePath = path.join(parent, "codex-proposal-turns.json");
  writeFileSync(statePath, JSON.stringify({ turn: 0, responses }));
  return writeProviderExecutable(
    path.join(parent, "codex.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
if (!(process.argv[2] === "exec" && process.argv.includes("--json"))) process.exit(9);
const prompt = readFileSync(0, "utf8");
const isPeerPrompt = prompt.includes("The following is a delegation message from a peer.") || prompt.includes("The following is a message from a peer.");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const text = isPeerPrompt
  ? (state.responses[Math.min(state.turn, state.responses.length - 1)] ?? "fallback advisory response")
  : "worker runtime completed";
if (isPeerPrompt) {
  state.turn += 1;
  writeFileSync(statePath, JSON.stringify(state));
}
const lines = [
  { type: "thread.started", thread_id: "ceo-phase2-session" },
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
      body: `# Work decision for ${workId}\n\n## 背景\n\nAuthorize test work root.\n\n## 权衡\n\nNeeded for Resident CEO Phase 2 test.\n\n## 结论\n\nProceed.\n`,
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
  "negative control: default advisory-only resident CEO answers read-only without proposals and rejects approve/reject writes",
  { timeout: 90_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-p2-advisory-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-p2-advisory";
    const installation = {
      installationId: "ceo-p2-codex-advisory",
      kindId: "codex" as const,
      executablePath: writeProposalCodexStub(parent, [
        JSON.stringify({
          action: "propose_task",
          title: "Unauthorized task creation",
          workId: "task_work_1",
          rationale: "Must be ignored in advisory-only mode.",
        }),
      ]),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      runtimeDiscover: () => [installation],
    });
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Advisory fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });

      const delegated = await host.run(
        repoId,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Run release check" },
        auth,
      );
      assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
      const { request } = evidence(delegated) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const bobAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

      // Omit executionPolicy -> defaults strictly to advisory-only.
      assert.equal(
        (await ceo("config", { runtimeInstanceId: "codex-provider", model: "test-model", heartbeatIntervalSec: 300 }))
          .ok,
        true,
      );
      assert.equal((await ceo("start")).ok, true);

      await eventuallyValue(async () => {
        const status = await ceo("status");
        const profile = status.profile as { readonly lastWake: { readonly status: string } | null };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.status === "succeeded" ? profile : null;
      }, "advisory-only resident CEO settles peer delegation");

      // Zero proposals created; PeerRequest transitioned directly to ANSWERED (Phase 1 behavior).
      const listed = await ceo("proposals");
      assert.equal(listed.ok, true, JSON.stringify(listed));
      assert.deepEqual(listed.proposals, []);

      const deniedApprove = await ceo("approve", { proposalId: "prop_fake", workId: "task_work_1" });
      assert.equal(deniedApprove.ok, false);
      assert.equal((deniedApprove.error as { code?: string })?.code, "resident_ceo_advisory_only");

      const deniedReject = await ceo("reject", { proposalId: "prop_fake", reason: "Not allowed" });
      assert.equal(deniedReject.ok, false);
      assert.equal((deniedReject.error as { code?: string })?.code, "resident_ceo_advisory_only");

      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceWatch = evidence(
        await host.run(repoId, { kind: "peer-watch", once: true, replyTo: request.requestId }, auth),
      ) as { matched: boolean; request: PeerRequestV1 };
      assert.equal(aliceWatch.matched, true);
      assert.equal(aliceWatch.request.state, "ANSWERED");
      assert.equal(aliceWatch.request.promotedTaskId, null);
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);

test(
  "approval-gated end-to-end: peer delegate -> structured proposal -> owner approve -> atomic PROMOTED + task -> terminal outcome writeback",
  { timeout: 120_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-p2-e2e-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-p2-e2e";
    const installation = {
      installationId: "ceo-p2-codex-e2e",
      kindId: "codex" as const,
      executablePath: writeProposalCodexStub(parent, [
        JSON.stringify({
          action: "propose_task",
          title: "Verify Phase 2 migration",
          workId: "task_ceo_p2_work",
          prompt: "Audit the migration plan and verify invariants.",
          rationale: "Structured engineering delegation requires tracked HA task ownership.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Duplicate cleanup",
          workId: "task_ceo_p2_work",
          rationale: "Needs owner confirmation.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Allowlisted auto-promoted task",
          workId: "task_ceo_p2_work",
          rationale: "Trusted sender allowlist delegation.",
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
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Phase 2 fixture",
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
      await createWorkRoot(host, userRoot, repoId, "task_ceo_p2_work", "Resident CEO Phase 2 Work", bobAuth);

      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

      const configured = await ceo("config", {
        runtimeInstanceId: "codex-provider",
        model: "test-model",
        heartbeatIntervalSec: 300,
        executionPolicy: "approval-gated",
        defaultWorkId: "task_ceo_p2_work",
      });
      assert.equal(configured.ok, true, JSON.stringify(configured));
      assert.equal((await ceo("start")).ok, true);

      // 1. Alice sends a peer delegate to Bob's approval-gated resident CEO.
      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const delegated1 = await host.run(
        repoId,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Verify migration invariants" },
        aliceAuth,
      );
      assert.equal(delegated1.outcome, "applied", JSON.stringify(delegated1));
      const { request: peerReq1 } = evidence(delegated1) as { request: PeerRequestV1 };

      // Switch back to Bob's session so Bob's resident CEO processes the delegation.
      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const pendingProposal = await eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "pending_approval" });
        assert.equal(listed.ok, true, JSON.stringify(listed));
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        return items.find((entry) => entry.peerRequestId === peerReq1.requestId) ?? null;
      }, "approval-gated resident CEO creates pending proposal");

      assert.equal(pendingProposal.status, "pending_approval");
      assert.equal(pendingProposal.proposedTitle, "Verify Phase 2 migration");
      assert.equal(pendingProposal.proposedWorkId, "task_ceo_p2_work");

      // Before owner approval, PeerRequest remains OPEN (not prematurely ANSWERED or PROMOTED).
      const inboxBeforeApproval = evidence(
        await host.run(repoId, { kind: "peer-inbox", state: "OPEN", limit: 10 }, bobAuth),
      ) as { requests: PeerRequestV1[] };
      assert.ok(inboxBeforeApproval.requests.some((entry) => entry.requestId === peerReq1.requestId));

      // 2. Owner approves proposal -> atomic PeerRequest PROMOTED + linked HA Task created under work.
      const approved = await ceo("approve", { proposalId: pendingProposal.proposalId });
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const promotedTaskId = approved.promotedTaskId as string;
      assert.ok(promotedTaskId && promotedTaskId.startsWith("task_"), JSON.stringify(approved));
      const approvedProposal = approved.proposal as ResidentCeoDelegationProposal;
      assert.equal(approvedProposal.status, "promoted");
      assert.equal(approvedProposal.approvalMode, "manual");
      assert.equal(approvedProposal.promotedTaskId, promotedTaskId);

      const shownTask = evidence(await host.run(repoId, { kind: "task-show", taskId: promotedTaskId }, bobAuth)) as {
        task: {
          readonly taskId: string;
          readonly title: string;
          readonly status: string;
          readonly metadata?: { readonly parentTaskId?: string | null };
        };
      };
      assert.equal(shownTask.task.title, "Verify Phase 2 migration");
      assert.equal(shownTask.task.metadata?.parentTaskId, "task_ceo_p2_work");

      // 3. Promoted Task reaches terminal state (cancelled) -> watcher propagates terminal outcome back to PeerRequest + sender inbox.
      const cancelled = await host.run(
        repoId,
        {
          kind: "task-transition",
          taskId: promotedTaskId,
          status: "cancelled",
          reason: "Superseded after verification",
        },
        bobAuth,
      );
      assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));

      const propagated = await eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "promoted" });
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        const match = items.find((entry) => entry.proposalId === pendingProposal.proposalId);
        return match?.terminalOutcome ? match : null;
      }, "resident CEO propagates promoted task terminal outcome back to PeerRequest");
      assert.equal(propagated.terminalOutcome?.taskStatus, "cancelled");

      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceFinalView = evidence(
        await host.run(repoId, { kind: "peer-watch", once: true, replyTo: peerReq1.requestId }, aliceAuth),
      ) as { matched: boolean; request: PeerRequestV1 };
      assert.equal(aliceFinalView.matched, true);
      assert.equal(aliceFinalView.request.state, "PROMOTED");
      assert.equal(aliceFinalView.request.promotedTaskId, promotedTaskId);
      assert.match(aliceFinalView.request.reply?.structuredBody.claim ?? "", new RegExp(promotedTaskId, "u"));
      assert.match(aliceFinalView.request.reply?.structuredBody.claim ?? "", /cancelled/u);

      // 4. Second delegation -> owner rejects proposal -> PeerRequest transitions to REJECTED.
      const delegated2 = await host.run(
        repoId,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Duplicate cleanup request" },
        aliceAuth,
      );
      assert.equal(delegated2.outcome, "applied", JSON.stringify(delegated2));
      const { request: peerReq2 } = evidence(delegated2) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const proposal2 = await eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "pending_approval" });
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        return items.find((entry) => entry.peerRequestId === peerReq2.requestId) ?? null;
      }, "resident CEO records second pending proposal for rejection");

      const rejected = await ceo("reject", { proposalId: proposal2.proposalId, reason: "Duplicate of existing work" });
      assert.equal(rejected.ok, true, JSON.stringify(rejected));
      assert.equal((rejected.proposal as ResidentCeoDelegationProposal).status, "rejected");

      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const rejectedView = evidence(
        await host.run(repoId, { kind: "peer-watch", once: true, replyTo: peerReq2.requestId }, aliceAuth),
      ) as { matched: boolean; request: PeerRequestV1 };
      assert.equal(rejectedView.matched, true);
      assert.equal(rejectedView.request.state, "REJECTED");
      assert.equal(rejectedView.request.rejectionReason, "Duplicate of existing work");

      // 5. Allowlist auto-approval: configure person_alice in autoApproveSenders -> third delegation promotes automatically.
      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const withAllowlist = await ceo("config", {
        runtimeInstanceId: "codex-provider",
        model: "test-model",
        heartbeatIntervalSec: 300,
        executionPolicy: "approval-gated",
        defaultWorkId: "task_ceo_p2_work",
        autoApproveSenders: ["person_alice"],
      });
      assert.equal(withAllowlist.ok, true, JSON.stringify(withAllowlist));

      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const delegated3 = await host.run(
        repoId,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Allowlisted auto-promotion" },
        aliceAuth,
      );
      assert.equal(delegated3.outcome, "applied", JSON.stringify(delegated3));
      const { request: peerReq3 } = evidence(delegated3) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const autoPromoted = await eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "promoted" });
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        return items.find((entry) => entry.peerRequestId === peerReq3.requestId) ?? null;
      }, "allowlisted sender delegation auto-promotes to HA task");
      assert.equal(autoPromoted.approvalMode, "allowlist-auto");
      assert.ok(autoPromoted.promotedTaskId?.startsWith("task_"));
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);

test(
  "regression: approval-gated promote -> task-start -> spawnRuntime passes real plan_placeholder validation and dispatches agent",
  { timeout: 120_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-p2-dispatch-plan-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-p2-dispatch-plan";
    const installation = {
      installationId: "ceo-p2-codex-dispatch",
      kindId: "codex" as const,
      executablePath: writeProposalCodexStub(parent, [
        JSON.stringify({
          action: "propose_task",
          title: "Run live dispatch regression",
          workId: "task_ceo_p2_dispatch_work",
          agentId: "delegated-worker",
          prompt: "Verify that promoted tasks include a complete canonical plan before task-start.",
          rationale: "Live approval must pass plan_placeholder readiness and launch the worker runtime.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Run allowlist dispatch regression",
          workId: "task_ceo_p2_dispatch_work",
          agentId: "delegated-worker",
          prompt: "Verify allowlist-auto promoted tasks also start and spawn without plan_placeholder failure.",
          rationale: "Allowlist auto-approval uses the same promotion path.",
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
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Phase 2 Dispatch fixture",
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
      await createWorkRoot(host, userRoot, repoId, "task_ceo_p2_dispatch_work", "Resident CEO Dispatch Work", bobAuth);

      const installed = await host.run(
        repoId,
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "delegated-worker",
            name: "Delegated Worker",
            instructions: "Execute approved delegated tasks and verify every requirement.",
            runtimes: [{ type: "codex" }],
          },
          expectedVersion: 0,
          idempotencyKey: "install-delegated-worker-p2",
        },
        bobAuth,
      );
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));

      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

      const configured = await ceo("config", {
        runtimeInstanceId: "codex-provider",
        model: "test-model",
        heartbeatIntervalSec: 300,
        executionPolicy: "approval-gated",
        defaultWorkId: "task_ceo_p2_dispatch_work",
        defaultAgentId: "delegated-worker",
      });
      assert.equal(configured.ok, true, JSON.stringify(configured));
      assert.equal((await ceo("start")).ok, true);

      // 1. Manual approval path: peer-promote -> task-start (with real plan_placeholder gate) -> spawnRuntime.
      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const delegated1 = await host.run(
        repoId,
        {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Execute manual dispatch regression",
        },
        aliceAuth,
      );
      assert.equal(delegated1.outcome, "applied", JSON.stringify(delegated1));
      const { request: peerReq1 } = evidence(delegated1) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const pendingProposal = await eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "pending_approval" });
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        return items.find((entry) => entry.peerRequestId === peerReq1.requestId) ?? null;
      }, "resident CEO creates pending proposal with default agent");

      const approved = await ceo("approve", { proposalId: pendingProposal.proposalId });
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const approvedProposal = approved.proposal as ResidentCeoDelegationProposal;
      assert.equal(approvedProposal.status, "promoted");
      assert.equal(approvedProposal.dispatchError, null, JSON.stringify(approvedProposal));
      assert.equal(typeof approvedProposal.dispatchRuntimeSessionId, "string", JSON.stringify(approvedProposal));
      assert.ok((approvedProposal.dispatchRuntimeSessionId ?? "").length > 0, JSON.stringify(approvedProposal));

      const startedTask = evidence(
        await host.run(repoId, { kind: "task-show", taskId: approvedProposal.promotedTaskId }, bobAuth),
      ) as { task: { readonly status: string } };
      assert.equal(startedTask.task.status, "active", JSON.stringify(startedTask));

      // 2. Allowlist-auto path: peer-promote -> task-start -> spawnRuntime without manual approve.
      // Pause Bob's watcher while switching the shared test userRoot session to Alice so the
      // background watcher does not race with Alice's temporary sign-in.
      assert.equal((await ceo("stop")).ok, true);
      const withAllowlist = await ceo("config", {
        runtimeInstanceId: "codex-provider",
        model: "test-model",
        heartbeatIntervalSec: 300,
        executionPolicy: "approval-gated",
        defaultWorkId: "task_ceo_p2_dispatch_work",
        defaultAgentId: "delegated-worker",
        autoApproveSenders: ["person_alice"],
      });
      assert.equal(withAllowlist.ok, true, JSON.stringify(withAllowlist));

      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const delegated2 = await host.run(
        repoId,
        {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Execute allowlist dispatch regression",
        },
        aliceAuth,
      );
      assert.equal(delegated2.outcome, "applied", JSON.stringify(delegated2));
      const { request: peerReq2 } = evidence(delegated2) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      assert.equal((await ceo("start")).ok, true);
      const autoPromoted = await eventuallyValue(async () => {
        const listed = await ceo("proposals", { status: "promoted" });
        const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
        return items.find((entry) => entry.peerRequestId === peerReq2.requestId) ?? null;
      }, "allowlist-auto promotes, starts, and dispatches runtime");
      assert.equal(autoPromoted.approvalMode, "allowlist-auto");
      assert.equal(autoPromoted.dispatchError, null, JSON.stringify(autoPromoted));
      assert.equal(typeof autoPromoted.dispatchRuntimeSessionId, "string", JSON.stringify(autoPromoted));
      assert.ok((autoPromoted.dispatchRuntimeSessionId ?? "").length > 0, JSON.stringify(autoPromoted));
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);
