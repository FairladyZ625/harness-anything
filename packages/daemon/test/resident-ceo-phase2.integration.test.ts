// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import type { ResidentCeoDelegationProposal } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { decideNodeAutoClaim } from "../src/daemon-host/node-auto-claim.ts";
import type { JsonObject } from "../src/daemon-host/protocol/json-rpc-types.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { eventuallyValue, initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { policyTestDeviceToken, policyTestRealm, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
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
let text = "worker runtime completed";
if (isPeerPrompt) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  text = state.responses[Math.min(state.turn, state.responses.length - 1)] ?? "fallback advisory response";
  state.turn += 1;
  writeFileSync(statePath, JSON.stringify(state));
}
const lines = [
  { type: "thread.started", thread_id: isPeerPrompt ? "ceo-phase2-session" : "worker-phase2-session" },
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
  async (t) => {
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
    t.after(async () => {
      await host.close();
      removeTempRepository(parent);
    });
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
    const waitBounded = async <T>(read: () => Promise<T | null>, label: string, timeoutMs = 45_000): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await read();
        if (value !== null) return value;
        const status = await ceo("status");
        const profile = status.profile as {
          readonly lastWake?: { readonly status?: string; readonly detail?: string | null } | null;
          readonly proposals?: readonly ResidentCeoDelegationProposal[];
        } | null;
        assert.notEqual(
          profile?.lastWake?.status,
          "failed",
          `${label}: resident CEO wake failed: ${JSON.stringify(profile?.lastWake)}`,
        );
        if (Date.now() >= deadline) {
          const inbox = await host.run(repoId, { kind: "peer-inbox", state: "OPEN", limit: 10 }, bobAuth);
          assert.fail(
            `${label}: timed out after ${timeoutMs}ms; lastWake=${JSON.stringify(profile?.lastWake)} proposals=${JSON.stringify(profile?.proposals)} inbox=${inbox.evidence}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const configured = await ceo("config", {
      runtimeInstanceId: "codex-provider",
      model: "test-model",
      heartbeatIntervalSec: 300,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_ceo_p2_dispatch_work",
      defaultAgentId: "delegated-worker",
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));

    // 1. Manual approval path: peer-promote -> task-start (with real plan_placeholder gate) -> spawnRuntime.
    // Send Alice's peer request before starting Bob's watcher so the shared test userRoot session
    // stays signed in as Bob for the entire time Bob's background watcher is running.
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
    assert.equal((await ceo("start")).ok, true);
    const pendingProposal = await waitBounded(async () => {
      const status = await ceo("status");
      const profile = status.profile as {
        readonly lastWake?: { readonly status?: string } | null;
        readonly proposals?: readonly ResidentCeoDelegationProposal[];
      } | null;
      if (profile?.lastWake?.status !== "succeeded") return null;
      const items = profile.proposals ?? [];
      return (
        items.find((entry) => entry.peerRequestId === peerReq1.requestId && entry.status === "pending_approval") ?? null
      );
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
    const autoPromoted = await waitBounded(async () => {
      const listed = await ceo("proposals", { status: "promoted" });
      const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
      return items.find((entry) => entry.peerRequestId === peerReq2.requestId) ?? null;
    }, "allowlist-auto promotes, starts, and dispatches runtime");
    assert.equal(autoPromoted.approvalMode, "allowlist-auto");
    assert.equal(autoPromoted.dispatchError, null, JSON.stringify(autoPromoted));
    assert.equal(typeof autoPromoted.dispatchRuntimeSessionId, "string", JSON.stringify(autoPromoted));
    assert.ok((autoPromoted.dispatchRuntimeSessionId ?? "").length > 0, JSON.stringify(autoPromoted));
  },
);

test(
  "resident CEO read-only peer-ask wake queries sanitized fleet status and runtime instances via real CLI while non-allowlisted commands remain rejected",
  { timeout: 120_000 },
  async (t) => {
    const parent = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ha-ceo-ro-fleet-runtime-"))),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      probeOutputPath = path.join(parent, "ceo-cli-probe.json"),
      repoId = "ceo-ro-fleet-runtime",
      daemonId = "ceo-ro-fleet-runtime-test",
      cliEntry = path.resolve("packages/cli/src/index.ts"),
      realm = await serveKeycloak();
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      removeTempRepository(parent);
    });
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    execFileSync("git", ["-C", rootDir, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    realm.bind(userRoot);
    for (const personId of ["person_alice", "person_bob"]) {
      realm.keycloak.account(personId);
      realm.keycloak.permit(personId, repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    }
    signInAt(userRoot, "person_bob");
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });

    const executablePath = writeProviderExecutable(
      path.join(parent, "codex.mjs"),
      `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
readFileSync(0, "utf8");
const cli = ${JSON.stringify(cliEntry)};
const root = ${JSON.stringify(rootDir)};
const runCli = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [cli, "--root", root, "--json", ...args], {
      encoding: "utf8",
      env: process.env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
};
const results = {
  fleetStatus: runCli(["daemon", "fleet", "status"]),
  runtimeList: runCli(["runtime", "instance", "list"]),
  runtimeProbe: runCli(["runtime", "instance", "list", "--probe"]),
  runtimeShow: runCli(["runtime", "instance", "show", "codex-provider"]),
  taskCreate: runCli(["task", "create", "--title", "Forbidden from peer-ask"]),
};
writeFileSync(${JSON.stringify(probeOutputPath)}, JSON.stringify(results));
console.log(JSON.stringify({ type: "thread.started", thread_id: "ceo-ro-fleet-session" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "msg", type: "agent_message", text: "Fleet and runtime metadata queried read-only." } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    );

    const daemon = await startDaemon({
      daemonId,
      userRoot,
      buildSupersessionEnabled: false,
      runtimeDiscover: () => [
        {
          installationId: "ceo-ro-codex",
          kindId: "codex",
          executablePath,
          version: "codex-cli 0.159.1",
          observedAt: new Date().toISOString(),
        },
      ],
    });
    assert.ok("stop" in daemon);
    stop = daemon.stop;
    const daemonRpc = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000);

    await eventuallyValue(async () => {
      const status = await daemonRpc("daemon.status", {});
      return (status.repos as { readonly repoId: string; readonly state: string }[]).some(
        (repo) => repo.repoId === repoId && repo.state === "attached",
      )
        ? true
        : null;
    }, "daemon attaches repository");

    const createdPrimary = await daemonRpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "codex-provider",
        name: "Resident CEO Codex",
        kindId: "codex",
        installationId: "ceo-ro-codex",
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      },
    });
    assert.equal(createdPrimary.ok, true, JSON.stringify(createdPrimary));
    const createdSecret = await daemonRpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "codex-api-secret",
        name: "Private API Gateway",
        kindId: "codex",
        installationId: "ceo-ro-codex",
        providerId: "custom-gateway",
        models: ["gpt-6-sol"],
        authMode: "api-key",
        credentialRef: "credential:v1:codex-api-secret",
        codex: {
          baseUrl: "https://private.gateway.invalid/v1",
          httpHeaders: { "X-Gateway-Route": "private-sidecar-route" },
          credentialHeader: "X-Resident-Key",
        },
      },
    });
    assert.equal(createdSecret.ok, true, JSON.stringify(createdSecret));

    // Configure Resident CEO for Bob, then send a peer-ask from Alice and start Bob's Resident CEO.
    assert.equal(
      (
        await daemonRpc("repo.residentCeo.config", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: "codex-provider",
            model: "test-model",
            heartbeatIntervalSec: 300,
          },
        })
      ).ok,
      true,
    );
    signInAt(userRoot, "person_alice");
    const asked = await daemonRpc("repo.task.run", {
      repo: { repoId },
      payload: {
        action: {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Report fleet node status and available runtime models",
        },
      },
    });
    assert.equal(asked.outcome, "applied", JSON.stringify(asked));

    signInAt(userRoot, "person_bob");
    assert.equal((await daemonRpc("repo.residentCeo.start", { repo: { repoId }, payload: {} })).ok, true);

    await eventuallyValue(async () => {
      const status = await daemonRpc("repo.residentCeo.status", { repo: { repoId }, payload: {} });
      const profile = status.profile as {
        readonly lastWake?: { readonly status?: string; readonly detail?: string | null } | null;
      } | null;
      assert.notEqual(profile?.lastWake?.status, "failed", JSON.stringify(profile?.lastWake));
      return profile?.lastWake?.status === "succeeded" ? profile : null;
    }, "resident CEO settles peer-ask read-only wake");

    const observed = JSON.parse(readFileSync(probeOutputPath, "utf8")) as Record<
      string,
      { readonly status: number; readonly stdout: string; readonly stderr: string }
    >;
    const parseReceipt = (raw: { readonly stdout: string }) =>
      JSON.parse(raw.stdout.slice(raw.stdout.indexOf("{"))) as Record<string, unknown>;

    const fleetBody = parseReceipt(observed.fleetStatus!);
    assert.equal(fleetBody.ok, true, JSON.stringify(observed.fleetStatus));
    assert.equal(fleetBody.schema, "daemon.fleet-overview/v1");
    assert.equal(fleetBody.repoId, repoId);
    assert.equal(observed.fleetStatus!.stdout.includes(parent), false);

    const runtimeBody = parseReceipt(observed.runtimeList!);
    assert.equal(runtimeBody.ok, true, JSON.stringify(observed.runtimeList));
    const listedInstances = runtimeBody.instances as readonly { readonly instanceId: string }[];
    assert.ok(listedInstances.some((entry) => entry.instanceId === "codex-provider"));
    assert.ok(listedInstances.some((entry) => entry.instanceId === "codex-api-secret"));
    for (const forbidden of [
      "credential:v1:codex-api-secret",
      "private.gateway.invalid",
      "X-Gateway-Route",
      "private-sidecar-route",
      "X-Resident-Key",
      "http_headers",
      "credential_header",
      "credentialRef",
      "executablePath",
      parent,
    ]) {
      assert.equal(
        observed.runtimeList!.stdout.includes(forbidden),
        false,
        `resident CEO runtime instance list must not leak ${forbidden}`,
      );
    }

    for (const key of ["runtimeProbe", "runtimeShow", "taskCreate"] as const) {
      const combined = `${observed[key]!.stdout}${observed[key]!.stderr}`;
      assert.match(combined, /execution_credential_rejected/u, `${key} must be rejected`);
      assert.match(combined, /allowlisted ledger queries/u, `${key} must explain the read-only allowlist`);
    }
  },
);

test(
  "Option A targetNodeId: local/empty dispatches locally; remote targetNodeId and --target-node override assign to node for node-auto-claim and skip local spawn",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-p2-target-node-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-p2-target-node";
    const installation = {
      installationId: "ceo-p2-codex-target-node",
      kindId: "codex" as const,
      executablePath: writeProposalCodexStub(parent, [
        JSON.stringify({
          action: "propose_task",
          title: "Local target node execution",
          workId: "task_ceo_p2_node_work",
          agentId: "delegated-worker",
          targetNodeId: "center",
          prompt: "Run on local center node.",
          rationale: "Matches local center nodeId.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Remote edge offload",
          workId: "task_ceo_p2_node_work",
          agentId: "delegated-worker",
          targetNodeId: "cea7e947",
          prompt: "Offload task to remote node cea7e947.",
          rationale: "Remote compute node requested by proposal.",
        }),
        JSON.stringify({
          action: "propose_task",
          title: "Approve override to dotted remote node",
          workId: "task_ceo_p2_node_work",
          agentId: "delegated-worker",
          targetNodeId: "center",
          prompt: "Owner overrides target node at approval time.",
          rationale: "Proposal defaults to center before owner override.",
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
      name: "Resident CEO Target Node fixture",
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
    await createWorkRoot(host, userRoot, repoId, "task_ceo_p2_node_work", "Resident CEO Target Node Work", bobAuth);
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
        idempotencyKey: "install-delegated-worker-opt-a",
      },
      bobAuth,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));

    const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
      rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });
    assert.equal(
      (
        await ceo("config", {
          runtimeInstanceId: "codex-provider",
          model: "test-model",
          heartbeatIntervalSec: 300,
          executionPolicy: "approval-gated",
          defaultWorkId: "task_ceo_p2_node_work",
          defaultAgentId: "delegated-worker",
        })
      ).ok,
      true,
    );

    // Register the remote fleet nodes in Keycloak before approval so task-assign verifies active node targets.
    policyTestRealm.keycloak.node("cea7e947", "person_bob");
    policyTestRealm.keycloak.node("edge-mac.prod-1", "person_bob");
    policyTestRealm.keycloak.node("other-edge-node", "person_bob");
    const fleetAuthForNode = (nodeId: string) => {
      const token = policyTestDeviceToken("person_bob", nodeId);
      return {
        transportKind: "fleet-tls" as const,
        humanAccessToken: token,
        nodePrincipal: { nodeId, personId: "person_bob" },
      };
    };
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

    // (a) targetNodeId === local nodeId ("center") -> local task-start + spawnRuntime
    const localProposal = await sendDelegation("Run on local center node");
    assert.equal(localProposal.proposedTargetNodeId, "center");
    const localApproved = await ceo("approve", { proposalId: localProposal.proposalId });
    assert.equal(localApproved.ok, true, JSON.stringify(localApproved));
    const localResult = localApproved.proposal as ResidentCeoDelegationProposal;
    assert.equal(localResult.status, "promoted");
    assert.equal(localResult.dispatchError, null, JSON.stringify(localResult));
    assert.equal(localResult.dispatchedTargetNodeId, null);
    assert.equal(typeof localResult.dispatchRuntimeSessionId, "string");
    assert.ok((localResult.dispatchRuntimeSessionId ?? "").length > 0);
    const localTask = evidence(
      await host.run(repoId, { kind: "task-show", taskId: localResult.promotedTaskId }, bobAuth),
    ) as { task: { readonly status: string } };
    assert.equal(localTask.task.status, "active");

    // (b) targetNodeId === "cea7e947" (remote) -> peer-promote + task-assign --node cea7e947, skip local spawn, visible in readNodeAutoClaimCandidates
    const remoteProposal = await sendDelegation("Offload to cea7e947");
    assert.equal(remoteProposal.proposedTargetNodeId, "cea7e947");
    const remoteApproved = await ceo("approve", { proposalId: remoteProposal.proposalId });
    assert.equal(remoteApproved.ok, true, JSON.stringify(remoteApproved));
    const remoteResult = remoteApproved.proposal as ResidentCeoDelegationProposal;
    assert.equal(remoteResult.status, "promoted");
    assert.equal(remoteResult.dispatchError, null, JSON.stringify(remoteResult));
    assert.equal(remoteResult.dispatchRuntimeSessionId, null, JSON.stringify(remoteResult));
    assert.equal(remoteResult.dispatchedTargetNodeId, "cea7e947");
    assert.ok(remoteResult.promotedTaskId?.startsWith("task_"));

    const remoteTask = evidence(
      await host.run(repoId, { kind: "task-show", taskId: remoteResult.promotedTaskId }, bobAuth),
    ) as {
      task: {
        readonly status: string;
        readonly assignment: { readonly assignee: { readonly kind: string; readonly nodeId?: string } } | null;
      };
    };
    assert.equal(remoteTask.task.status, "planned", JSON.stringify(remoteTask));
    assert.equal(remoteTask.task.assignment?.assignee.kind, "node");
    assert.equal(remoteTask.task.assignment?.assignee.nodeId, "cea7e947");

    const ceaCandidates = await host.readNodeAutoClaimCandidates(repoId, fleetAuthForNode("cea7e947"));
    const matchedCandidate = ceaCandidates.candidates.find((entry) => entry.taskId === remoteResult.promotedTaskId);
    assert.ok(matchedCandidate, JSON.stringify(ceaCandidates));
    assert.ok(matchedCandidate.autoAssignment !== null, JSON.stringify(matchedCandidate));
    const claimDecision = decideNodeAutoClaim({
      policy: {
        schema: "node-auto-claim/v1",
        enabled: true,
        allowedSources: { personIds: [], teamIds: [] },
        allowedAgentIds: ["delegated-worker"],
        maxConcurrent: 2,
      },
      assignment: matchedCandidate.autoAssignment,
      ownerPersonId: "person_bob",
      now: new Date().toISOString(),
      agentId: "delegated-worker",
      activeCount: 0,
    });
    assert.deepEqual(claimDecision, { accepted: true, reason: "accepted" });

    // Unrelated node must not see cea7e947's assigned task in its auto-claim candidates.
    const otherNodeCandidates = await host.readNodeAutoClaimCandidates(repoId, fleetAuthForNode("other-edge-node"));
    assert.equal(
      otherNodeCandidates.candidates.some((entry) => entry.taskId === remoteResult.promotedTaskId),
      false,
      JSON.stringify(otherNodeCandidates),
    );

    // (c) ceo approve --target-node <remoteNodeId> overrides proposal.proposedTargetNodeId ("center") and assigns remotely
    const overrideProposal = await sendDelegation("Override center proposal to dotted remote node");
    assert.equal(overrideProposal.proposedTargetNodeId, "center");
    const overrideApproved = await ceo("approve", {
      proposalId: overrideProposal.proposalId,
      targetNodeId: "edge-mac.prod-1",
    });
    assert.equal(overrideApproved.ok, true, JSON.stringify(overrideApproved));
    const overrideResult = overrideApproved.proposal as ResidentCeoDelegationProposal;
    assert.equal(overrideResult.status, "promoted");
    assert.equal(overrideResult.proposedTargetNodeId, "edge-mac.prod-1");
    assert.equal(overrideResult.dispatchedTargetNodeId, "edge-mac.prod-1");
    assert.equal(overrideResult.dispatchRuntimeSessionId, null);
    assert.equal(overrideResult.dispatchError, null);

    const overrideCandidates = await host.readNodeAutoClaimCandidates(repoId, fleetAuthForNode("edge-mac.prod-1"));
    assert.ok(
      overrideCandidates.candidates.some((entry) => entry.taskId === overrideResult.promotedTaskId),
      JSON.stringify(overrideCandidates),
    );

    // Verify terminal outcome writeback still fires for remotely assigned task once cancelled/completed.
    const cancelled = await host.run(
      repoId,
      {
        kind: "task-transition",
        taskId: remoteResult.promotedTaskId,
        status: "cancelled",
        reason: "Remote node completed verification",
      },
      bobAuth,
    );
    assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));
    const propagated = await eventuallyValue(async () => {
      const listed = await ceo("proposals", { status: "promoted" });
      const items = (listed.proposals ?? []) as ResidentCeoDelegationProposal[];
      const match = items.find((entry) => entry.proposalId === remoteProposal.proposalId);
      return match?.terminalOutcome ? match : null;
    }, "remotely assigned promoted task propagates terminal outcome");
    assert.equal(propagated.terminalOutcome?.taskStatus, "cancelled");
  },
);

test(
  "cross-kind local delegation: CEO claude profile does not override codex worker declared model on promote_and_dispatch or start_and_dispatch_existing, while explicit approve override still wins",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-cross-kind-model-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-cross-kind-model";
    const claudeTurnPath = path.join(parent, "claude-turns.json");
    const codexLaunchLogPath = path.join(parent, "codex-launches.json");

    writeFileSync(
      claudeTurnPath,
      JSON.stringify({
        turn: 0,
        responses: [
          JSON.stringify({
            action: "propose_task",
            title: "Cross-kind promote without override",
            workId: "task_ceo_xkind_work",
            agentId: "codex-worker",
            prompt: "Run worker with its own codex declaration.",
            rationale: "Verify CEO claude profile does not leak to codex worker.",
          }),
          JSON.stringify({
            action: "propose_task",
            title: "Cross-kind promote with explicit override",
            workId: "task_ceo_xkind_work",
            agentId: "codex-worker",
            prompt: "Run worker with explicit approve override.",
            rationale: "Negative control: explicit override must still apply.",
          }),
        ],
      }),
    );
    writeFileSync(codexLaunchLogPath, "");

    const claudeStub = writeProviderExecutable(
      path.join(parent, "claude.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
const prompt = readFileSync(0, "utf8");
let text = "ceo claude plain reply";
if (prompt.includes("Owner message:")) {
  const ownerMessage = prompt.slice(prompt.lastIndexOf("Owner message:"));
  const match = /task_[A-Za-z0-9_]+/u.exec(ownerMessage);
  text = JSON.stringify({
    reply: "Starting existing planned task.",
    actions: [
      {
        action: "start_and_dispatch_existing",
        taskId: match ? match[0] : "",
        agentId: "codex-worker",
        prompt: "Execute planned task with worker declared model.",
        rationale: "Owner requested starting existing task.",
      },
    ],
  });
} else if (prompt.includes("The following is a delegation message from a peer.")) {
  const statePath = ${JSON.stringify(claudeTurnPath)};
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  text = state.responses[Math.min(state.turn, state.responses.length - 1)] ?? "fallback";
  state.turn += 1;
  writeFileSync(statePath, JSON.stringify(state));
}
const lines = [
  { type: "system", subtype: "init", session_id: "ceo-claude-session" },
  { type: "assistant", session_id: "ceo-claude-session", message: { content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, session_id: "ceo-claude-session", result: text, permission_denials: [] },
];
lines.forEach((line, index) => setTimeout(() => console.log(JSON.stringify(line)), index * 15));
`,
    );

    const codexStub = writeProviderExecutable(
      path.join(parent, "codex.mjs"),
      `import { appendFileSync, readFileSync } from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
if (!(process.argv[2] === "exec" && process.argv.includes("--json"))) process.exit(9);
readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(codexLaunchLogPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const lines = [
  { type: "thread.started", thread_id: "worker-codex-session" },
  { type: "item.completed", item: { id: "msg", type: "agent_message", text: "codex worker completed" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
];
lines.forEach((line, index) => setTimeout(() => console.log(JSON.stringify(line)), index * 15));
`,
    );

    const claudeInstallation = {
      installationId: "ceo-xkind-claude",
      kindId: "claude" as const,
      executablePath: claudeStub,
      version: "2.1.305 (Claude Code)",
      observedAt: new Date().toISOString(),
    };
    const codexInstallation = {
      installationId: "ceo-xkind-codex",
      kindId: "codex" as const,
      executablePath: codexStub,
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };

    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      runtimeDiscover: () => [claudeInstallation, codexInstallation],
    });
    t.after(async () => {
      await host.close();
      removeTempRepository(parent);
    });
    await host.attachmentsSettled();

    await registerFixtureRuntimeInstance(host, repoId, auth, {
      instanceId: "claude-provider",
      name: "Resident CEO Light Claude",
      kindId: "claude",
      installationId: claudeInstallation.installationId,
      providerId: "anthropic",
      models: ["ceo-light-model"],
      authMode: "subscription",
      claude: {},
    });
    await registerFixtureRuntimeInstance(host, repoId, auth, {
      instanceId: "codex-provider",
      name: "Worker Strong Codex",
      kindId: "codex",
      installationId: codexInstallation.installationId,
      providerId: "openai",
      models: ["worker-strong-model", "worker-override-model"],
      authMode: "subscription",
      codex: {},
    });

    const bobAuth = {
      ...auth,
      oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
    };
    await createWorkRoot(host, userRoot, repoId, "task_ceo_xkind_work", "Cross-Kind Delegation Work", bobAuth);

    const installed = await host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "codex-worker",
          name: "Codex Worker",
          instructions: "Execute tasks strictly on codex with worker-strong-model.",
          runtimes: [{ type: "codex", model: "worker-strong-model" }],
        },
        expectedVersion: 0,
        idempotencyKey: "install-codex-worker-xkind",
      },
      bobAuth,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));

    const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
      rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

    // Configure Resident CEO on Claude (ceo-light-model) — different kind & model from codex-worker.
    const configured = await ceo("config", {
      runtimeInstanceId: "claude-provider",
      model: "ceo-light-model",
      heartbeatIntervalSec: 0,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_ceo_xkind_work",
      defaultAgentId: "codex-worker",
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));

    const readModelFlag = (argv: readonly string[]): string | null => {
      const idx = argv.findIndex((arg) => arg === "--model" || arg === "-m");
      return idx >= 0 ? (argv[idx + 1] ?? null) : null;
    };
    const readCodexLaunches = (): string[][] =>
      readFileSync(codexLaunchLogPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as string[]);

    // 1. promote_and_dispatch without explicit overrides -> must NOT fail with agent_runtime_unavailable
    //    and must launch codex-provider with worker-strong-model.
    signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
    const aliceAuth = {
      ...auth,
      oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
    };
    const delegated1 = await host.run(
      repoId,
      { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Cross-kind promote 1" },
      aliceAuth,
    );
    assert.equal(delegated1.outcome, "applied", JSON.stringify(delegated1));
    const { request: peerReq1 } = evidence(delegated1) as { request: PeerRequestV1 };

    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    assert.equal((await ceo("start")).ok, true);
    const pending1 = await eventuallyValue(async () => {
      const status = await ceo("status");
      const profile = status.profile as {
        readonly lastWake?: { readonly status?: string; readonly detail?: string | null } | null;
        readonly proposals?: readonly ResidentCeoDelegationProposal[];
      } | null;
      assert.notEqual(profile?.lastWake?.status, "failed", JSON.stringify(profile?.lastWake));
      const items = profile?.proposals ?? [];
      return (
        items.find((entry) => entry.peerRequestId === peerReq1.requestId && entry.status === "pending_approval") ?? null
      );
    }, "cross-kind proposal 1 recorded");

    const approved1 = await ceo("approve", { proposalId: pending1.proposalId });
    assert.equal(approved1.ok, true, JSON.stringify(approved1));
    const prop1 = approved1.proposal as ResidentCeoDelegationProposal;
    assert.equal(prop1.dispatchError, null, JSON.stringify(prop1));
    assert.ok(prop1.dispatchRuntimeSessionId, JSON.stringify(prop1));
    const session1 = await host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: prop1.dispatchRuntimeSessionId },
      bobAuth,
    );
    assert.equal(session1.session.instanceId, "codex-provider");
    const launchesAfter1 = await eventuallyValue(async () => {
      const parsed = readCodexLaunches();
      return parsed.length >= 1 ? parsed : null;
    }, "codex worker launch 1 recorded");
    assert.equal(readModelFlag(launchesAfter1[0]!), "worker-strong-model");

    // 2. start_and_dispatch_existing (owner-direct via human-chat) without explicit overrides ->
    //    must launch codex-provider with worker-strong-model.
    const plannedTaskId = "task_ceo_xkind_planned";
    const plannedTaskRes = await host.run(
      repoId,
      {
        kind: "task-create",
        taskId: plannedTaskId,
        title: "Planned cross-kind task",
        parentTaskId: "task_ceo_xkind_work",
        plan: [
          "# Planned cross-kind task",
          "",
          "Task Contract: harness-task v1",
          "",
          "## Brief",
          "Run planned task on codex worker.",
          "",
          "## Goal",
          "Verify start_and_dispatch_existing respects worker declared runtime.",
          "",
          "## Cheaper Alternatives",
          "- Manual dispatch.",
          "",
          "## Context",
          "- Resident CEO uses claude-provider.",
          "",
          "## Required Reading",
          "- Worker declaration.",
          "",
          "## Execution Surface",
          "- Worktree.",
          "",
          "## Constraints",
          "- Do not override worker model.",
          "",
          "## Deliverable Contract",
          "- Task started and dispatched.",
          "",
          "## Evidence Protocol",
          "- Verify codex stub launch.",
          "",
          "## Verification",
          "- Assert worker-strong-model.",
          "",
        ].join("\n"),
      },
      bobAuth,
    );
    assert.equal(plannedTaskRes.outcome, "applied", JSON.stringify(plannedTaskRes));

    const chatStart = await ceo("chat", { message: `Start planned task ${plannedTaskId}` });
    assert.equal(chatStart.ok, true, JSON.stringify(chatStart));
    const actionReceipts = (chatStart.actionReceipts ?? []) as readonly {
      readonly actionKind?: string;
      readonly outcome?: string;
      readonly runtimeSessionId?: string | null;
      readonly detail?: string;
    }[];
    const startReceipt = actionReceipts.find((entry) => entry.actionKind === "start_and_dispatch_existing");
    assert.ok(startReceipt, JSON.stringify(chatStart));
    assert.equal(startReceipt.outcome, "executed", JSON.stringify(startReceipt));
    assert.ok(startReceipt.runtimeSessionId, JSON.stringify(startReceipt));
    const session2 = await host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: startReceipt.runtimeSessionId },
      bobAuth,
    );
    assert.equal(session2.session.instanceId, "codex-provider");
    const launchesAfter2 = await eventuallyValue(async () => {
      const parsed = readCodexLaunches();
      return parsed.length >= 2 ? parsed : null;
    }, "codex worker launch 2 recorded");
    assert.equal(readModelFlag(launchesAfter2[1]!), "worker-strong-model");

    // 3. Negative control: explicit delegation-level override on approve still overrides the worker model.
    assert.equal((await ceo("stop")).ok, true);
    signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
    const delegated2 = await host.run(
      repoId,
      { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Cross-kind promote override" },
      aliceAuth,
    );
    assert.equal(delegated2.outcome, "applied", JSON.stringify(delegated2));
    const { request: peerReq2 } = evidence(delegated2) as { request: PeerRequestV1 };

    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    assert.equal((await ceo("start")).ok, true);
    const pending2 = await eventuallyValue(async () => {
      const status = await ceo("status");
      const profile = status.profile as {
        readonly lastWake?: { readonly status?: string; readonly detail?: string | null } | null;
        readonly proposals?: readonly ResidentCeoDelegationProposal[];
      } | null;
      assert.notEqual(profile?.lastWake?.status, "failed", JSON.stringify(profile?.lastWake));
      const items = profile?.proposals ?? [];
      return (
        items.find((entry) => entry.peerRequestId === peerReq2.requestId && entry.status === "pending_approval") ?? null
      );
    }, "cross-kind proposal 2 recorded");

    const approvedOverride = await ceo("approve", {
      proposalId: pending2.proposalId,
      runtimeInstanceId: "codex-provider",
      model: "worker-override-model",
    });
    assert.equal(approvedOverride.ok, true, JSON.stringify(approvedOverride));
    const prop2 = approvedOverride.proposal as ResidentCeoDelegationProposal;
    assert.equal(prop2.dispatchError, null, JSON.stringify(prop2));
    assert.ok(prop2.dispatchRuntimeSessionId, JSON.stringify(prop2));
    const launchesAfter3 = await eventuallyValue(async () => {
      const parsed = readCodexLaunches();
      return parsed.length >= 3 ? parsed : null;
    }, "codex worker launch 3 (override) recorded");
    assert.equal(readModelFlag(launchesAfter3[2]!), "worker-override-model");
  },
);
