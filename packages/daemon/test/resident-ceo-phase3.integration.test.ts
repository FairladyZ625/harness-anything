// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import type { ResidentCeoDelegationProposal } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import type { CredentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { evidence } from "./task-surface.fixtures.ts";

function createMemoryVault(): CredentialPort {
  const store = new Map<string, string>();
  let seq = 0;
  return {
    issue: () => `credential:v1:ceo-p3-${String(++seq)}`,
    store: async (reference, value) => void store.set(reference, value),
    resolve: async (reference) => {
      const value = store.get(reference);
      if (!value) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
      return value;
    },
    remove: async (reference) => void store.delete(reference),
  };
}

function writeProposalCodexStub(parent: string, responses: readonly string[]): string {
  const statePath = path.join(parent, "codex-p3-turns.json");
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
  { type: "thread.started", thread_id: isPeerPrompt ? "ceo-phase3-session" : "worker-phase3-session" },
  { type: "item.completed", item: { id: "msg", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
];
lines.forEach((line, index) => setTimeout(() => console.log(JSON.stringify(line)), index * 15));
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
      body: `# Work decision for ${workId}\n\n## 背景\n\nAuthorize test work root.\n\n## 权衡\n\nNeeded for Resident CEO Phase 3 test.\n\n## 结论\n\nProceed.\n`,
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

type QueuedDecisionResponse =
  | {
      readonly status: 200;
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly model?: string;
    }
  | {
      readonly status: 500;
      readonly error: string;
    };

test(
  "Phase 3 Decisions API approval gate: auto-promote, fail-closed fallbacks, secondary-guard, and mode=off regression",
  { timeout: 150_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ceo-p3-gate-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "ceo-p3-gate";
    const vault = createMemoryVault();

    const receivedRequests: Record<string, unknown>[] = [];
    const responseQueue: QueuedDecisionResponse[] = [
      // 1. auto-promote positive (0.94 >= 0.85)
      {
        status: 200,
        choice: "approve_low_risk",
        probabilities: { approve_low_risk: 0.94, require_human_approval: 0.04, insufficient_information: 0.02 },
        model: "decider-v1-resolved",
      },
      // 2. auto-promote fail-closed: low confidence (0.70 < 0.85)
      {
        status: 200,
        choice: "approve_low_risk",
        probabilities: { approve_low_risk: 0.7, require_human_approval: 0.2, insufficient_information: 0.1 },
      },
      // 3. auto-promote fail-closed: require_human_approval
      {
        status: 200,
        choice: "require_human_approval",
        probabilities: { approve_low_risk: 0.05, require_human_approval: 0.9, insufficient_information: 0.05 },
      },
      // 4. auto-promote fail-closed: abstain (insufficient_information)
      {
        status: 200,
        choice: "insufficient_information",
        probabilities: { approve_low_risk: 0.1, require_human_approval: 0.1, insufficient_information: 0.8 },
      },
      // 5. auto-promote fail-closed: provider HTTP 500 error
      { status: 500, error: "decider upstream failure" },
      // 6. secondary-guard: allowlisted sender intercepted by Decider
      {
        status: 200,
        choice: "require_human_approval",
        probabilities: { approve_low_risk: 0.08, require_human_approval: 0.88, insufficient_information: 0.04 },
      },
      // 7. secondary-guard: allowlisted sender approved by Decider
      {
        status: 200,
        choice: "approve_low_risk",
        probabilities: { approve_low_risk: 0.92, require_human_approval: 0.05, insufficient_information: 0.03 },
      },
    ];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        receivedRequests.push(body);
        const next = responseQueue.shift();
        if (!next) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unexpected extra decision request" } }));
          return;
        }
        if (next.status !== 200) {
          res.writeHead(next.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: next.error } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: next.model ?? "decider-v1",
            usage: { total_input_tokens: 42, total_output_tokens: 1 },
            answers: {
              decision: {
                type: "choice",
                choice: next.choice,
                probabilities: next.probabilities,
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    const proposalResponses = [
      { title: "Auto-promote safe test task", prompt: "Add parser unit tests." },
      { title: "Low confidence refactor", prompt: "Refactor shared state." },
      { title: "Risky credential rotation", prompt: "Rotate secrets across prod." },
      { title: "Ambiguous request", prompt: "Fix it." },
      { title: "Provider error request", prompt: "Run check during outage." },
      { title: "Missing provider request", prompt: "Run check with unknown provider." },
      { title: "Secondary guard intercepted", prompt: "Delete archived records." },
      { title: "Secondary guard approved", prompt: "Add read-only status metric." },
      { title: "Phase 2 off allowlist task", prompt: "Run allowlist without gate." },
    ].map((item) =>
      JSON.stringify({
        action: "propose_task",
        title: item.title,
        workId: "task_ceo_p3_work",
        agentId: "delegated-worker",
        prompt: item.prompt,
        rationale: `Proposal for ${item.title}`,
      }),
    );

    const installation = {
      installationId: "ceo-p3-codex",
      kindId: "codex" as const,
      executablePath: writeProposalCodexStub(parent, proposalResponses),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };

    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      runtimeCredentialPort: vault,
      runtimeDiscover: () => [installation],
    });
    t.after(async () => {
      await host.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeTempRepository(parent);
    });

    await host.attachmentsSettled();
    await registerFixtureRuntimeInstance(host, repoId, auth, {
      instanceId: "codex-provider",
      name: "Resident CEO Phase 3 fixture",
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
    await createWorkRoot(host, userRoot, repoId, "task_ceo_p3_work", "Resident CEO Phase 3 Work", bobAuth);

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
        idempotencyKey: "install-delegated-worker-p3",
      },
      bobAuth,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));

    const providerCreated = await host.decisionProvider(
      "daemon.provider.create",
      {
        type: "decisions",
        providerId: "gate-decider",
        vendor: "decisions-http",
        name: "Loopback Phase 3 Decider",
        model: "decider-v1",
        baseUrl: `http://127.0.0.1:${String(port)}`,
        apiKey: "sk-test-decider-key",
        maxRetries: 0,
      },
      bobAuth,
    );
    assert.equal(providerCreated.ok, true, JSON.stringify(providerCreated));

    const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
      rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

    const waitForProposal = async (peerRequestId: string, label: string, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
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
        const match = (profile?.proposals ?? []).find((entry) => entry.peerRequestId === peerRequestId);
        if (match && profile?.lastWake?.status === "succeeded") return match;
        if (Date.now() >= deadline) {
          assert.fail(
            `${label}: timed out waiting for ${peerRequestId}; lastWake=${JSON.stringify(profile?.lastWake)} proposals=${JSON.stringify(profile?.proposals)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const sendDelegationAndWait = async (summary: string, label: string) => {
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
      return { peerRequestId: request.requestId, proposal: await waitForProposal(request.requestId, label) };
    };

    // Configure auto-promote with Decisions API provider (person_alice is NOT in autoApproveSenders)
    const configured = await ceo("config", {
      runtimeInstanceId: "codex-provider",
      model: "test-model",
      heartbeatIntervalSec: 300,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_ceo_p3_work",
      defaultAgentId: "delegated-worker",
      gateMode: "auto-promote",
      gateProviderId: "gate-decider",
      gateMinConfidence: 0.85,
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const statusView = await ceo("status");
    assert.match(String(statusView.summary), /gate=auto-promote\(gate-decider\)@0\.85/u);

    // 1. Positive: non-allowlisted sender auto-promotes via Decider, starts task, and dispatches runtime
    const pos = await sendDelegationAndWait("Add parser unit tests", "auto-promote positive");
    assert.equal(pos.proposal.status, "promoted", JSON.stringify(pos.proposal));
    assert.equal(pos.proposal.approvalMode, "decider-auto");
    assert.equal(pos.proposal.dispatchError, null, JSON.stringify(pos.proposal));
    assert.equal(typeof pos.proposal.dispatchRuntimeSessionId, "string");
    assert.ok((pos.proposal.dispatchRuntimeSessionId ?? "").length > 0);
    assert.equal(pos.proposal.gateVerdict?.mode, "auto-promote");
    assert.equal(pos.proposal.gateVerdict?.selected, "approve_low_risk");
    assert.equal(pos.proposal.gateVerdict?.confidence, 0.94);
    assert.equal(pos.proposal.gateVerdict?.providerId, "gate-decider");
    assert.equal(pos.proposal.gateVerdict?.model, "decider-v1-resolved");
    assert.equal(pos.proposal.gateVerdict?.fallbackReason, null);

    const startedTask = evidence(
      await host.run(repoId, { kind: "task-show", taskId: pos.proposal.promotedTaskId }, bobAuth),
    ) as { task: { readonly status: string } };
    assert.equal(startedTask.task.status, "active");

    // Verify DecisionPort request contract & prompt-injection fencing
    const firstReq = receivedRequests[0] as {
      readonly state: readonly string[];
      readonly questions: {
        readonly decision: {
          readonly type: string;
          readonly abstainOptionId: string;
          readonly criteria: Record<string, unknown>;
        };
      };
    };
    assert.equal(firstReq.questions.decision.type, "choice");
    assert.equal(firstReq.questions.decision.abstainOptionId, "insufficient_information");
    assert.deepEqual(Object.keys(firstReq.questions.decision.criteria).sort(), [
      "approve_low_risk",
      "insufficient_information",
      "require_human_approval",
    ]);
    assert.match(firstReq.state[0] ?? "", /<<<UNTRUSTED_PROPOSAL_JSON_START>>>/u);
    assert.ok(!(firstReq.state[0] ?? "").includes("ceo-phase3-session"));

    const proposalsSummary = await ceo("proposals");
    assert.match(String(proposalsSummary.summary), /approval=decider-auto/u);
    assert.match(String(proposalsSummary.summary), /gate=auto-promote:approve_low_risk\(0\.94\/0\.85\)/u);

    // 2. Fail-closed: low confidence (< 0.85)
    const lowConf = await sendDelegationAndWait("Refactor shared state", "auto-promote low confidence");
    assert.equal(lowConf.proposal.status, "pending_approval");
    assert.equal(lowConf.proposal.promotedTaskId, null);
    assert.equal(lowConf.proposal.gateVerdict?.fallbackReason, "confidence_below_threshold");

    // 3. Fail-closed: require_human_approval
    const humanReq = await sendDelegationAndWait("Rotate secrets across prod", "auto-promote require human");
    assert.equal(humanReq.proposal.status, "pending_approval");
    assert.equal(humanReq.proposal.gateVerdict?.selected, "require_human_approval");
    assert.equal(humanReq.proposal.gateVerdict?.fallbackReason, "selected_require_human_approval");

    // 4. Fail-closed: abstain (insufficient_information)
    const abstained = await sendDelegationAndWait("Fix it", "auto-promote abstain");
    assert.equal(abstained.proposal.status, "pending_approval");
    assert.equal(abstained.proposal.gateVerdict?.selected, "insufficient_information");
    assert.equal(abstained.proposal.gateVerdict?.fallbackReason, "abstained_insufficient_information");

    // 5. Fail-closed: Decisions provider HTTP 500 error
    const providerErr = await sendDelegationAndWait("Run check during outage", "auto-promote provider error");
    assert.equal(providerErr.proposal.status, "pending_approval");
    assert.equal(providerErr.proposal.gateVerdict?.selected, null);
    assert.match(providerErr.proposal.gateVerdict?.fallbackReason ?? "", /decision_transport/u);

    // 6. Fail-closed: configured provider does not exist
    assert.equal((await ceo("stop")).ok, true);
    assert.equal(
      (
        await ceo("config", {
          runtimeInstanceId: "codex-provider",
          model: "test-model",
          heartbeatIntervalSec: 300,
          gateProviderId: "missing-provider",
        })
      ).ok,
      true,
    );
    const missingProvider = await sendDelegationAndWait("Run check with unknown provider", "missing provider");
    assert.equal(missingProvider.proposal.status, "pending_approval");
    assert.match(missingProvider.proposal.gateVerdict?.fallbackReason ?? "", /provider_not_found/u);

    // 7 & 8. secondary-guard: allowlisted sender intercepted vs approved
    assert.equal((await ceo("stop")).ok, true);
    assert.equal(
      (
        await ceo("config", {
          runtimeInstanceId: "codex-provider",
          model: "test-model",
          heartbeatIntervalSec: 300,
          autoApproveSenders: ["person_alice"],
          gateMode: "secondary-guard",
          gateProviderId: "gate-decider",
          gateMinConfidence: 0.85,
        })
      ).ok,
      true,
    );
    const guardBlocked = await sendDelegationAndWait("Delete archived records", "secondary-guard intercepted");
    assert.equal(guardBlocked.proposal.status, "pending_approval");
    assert.equal(guardBlocked.proposal.promotedTaskId, null);
    assert.equal(guardBlocked.proposal.gateVerdict?.mode, "secondary-guard");
    assert.equal(guardBlocked.proposal.gateVerdict?.fallbackReason, "selected_require_human_approval");

    const guardApproved = await sendDelegationAndWait("Add read-only status metric", "secondary-guard approved");
    assert.equal(guardApproved.proposal.status, "promoted");
    assert.equal(guardApproved.proposal.approvalMode, "decider-auto");
    assert.equal(guardApproved.proposal.dispatchError, null);
    assert.ok((guardApproved.proposal.dispatchRuntimeSessionId ?? "").length > 0);
    assert.equal(guardApproved.proposal.gateVerdict?.mode, "secondary-guard");

    // 9. Regression: gateMode="off" restores exact Phase 2 allowlist-auto without calling Decider
    const requestsBeforeOff = receivedRequests.length;
    assert.equal((await ceo("stop")).ok, true);
    assert.equal(
      (
        await ceo("config", {
          runtimeInstanceId: "codex-provider",
          model: "test-model",
          heartbeatIntervalSec: 300,
          gateMode: "off",
        })
      ).ok,
      true,
    );
    const phase2Off = await sendDelegationAndWait("Run allowlist without gate", "mode=off allowlist regression");
    assert.equal(phase2Off.proposal.status, "promoted");
    assert.equal(phase2Off.proposal.approvalMode, "allowlist-auto");
    assert.equal(phase2Off.proposal.gateVerdict, null);
    assert.equal(receivedRequests.length, requestsBeforeOff);
  },
);
