// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  isResidentCeoProfile,
  readResidentCeoHistoryReceipt,
  readResidentCeoProposalDecisionReceipt,
  readResidentCeoProposalsReceipt,
  readResidentCeoStatusReceipt,
  type ResidentCeoDelegationProposalRead,
  type ResidentCeoHistoryEntryRead,
  type ResidentCeoProfileRead,
} from "../src/renderer/api-client-resident-ceo.ts";

const api = vi.hoisted(() => ({
  getResidentCeo: vi.fn(),
  configureResidentCeo: vi.fn(),
  startResidentCeo: vi.fn(),
  stopResidentCeo: vi.fn(),
  chatResidentCeo: vi.fn(),
  getResidentCeoHistory: vi.fn(),
  listResidentCeoProposals: vi.fn(),
  approveResidentCeoProposal: vi.fn(),
  rejectResidentCeoProposal: vi.fn(),
  listInstances: vi.fn(),
  listAgents: vi.fn(),
  listDecisionProviders: vi.fn(),
}));

vi.mock("../src/renderer/api-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/api-client.ts")>()),
  harnessClient: api,
}));
vi.mock("../src/renderer/runtime-instance-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/runtime-instance-client.ts")>()),
  runtimeInstanceClient: { list: api.listInstances },
}));
vi.mock("../src/renderer/agent-entity-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/agent-entity-client.ts")>()),
  agentEntityClient: { listAgents: api.listAgents },
}));
vi.mock("../src/renderer/decision-provider-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/decision-provider-client.ts")>()),
  decisionProviderClient: { list: api.listDecisionProviders },
}));

import { ResidentCeoView } from "../src/renderer/views/ResidentCeoView.tsx";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const phase3Profile: ResidentCeoProfileRead = {
  schema: "resident-ceo-profile/v1",
  principalPersonId: "person_owner",
  repoId: "repo-one",
  runtimeInstanceId: "instance-one",
  model: "model-one",
  heartbeatIntervalSec: 300,
  executionPolicy: "approval-gated",
  defaultWorkId: "task_work_1",
  defaultAgentId: "neon",
  autoApproveSenders: ["person_trusted"],
  approvalGate: {
    mode: "auto-promote",
    providerId: "decider-1",
    minConfidence: 0.85,
  },
  persistentSessionId: "provider-session-one",
  status: "running",
  lastWake: {
    wakeId: "wake-chat-1",
    cause: "human-chat",
    requestedAt: "2026-11-27T01:00:00.000Z",
    completedAt: "2026-11-27T01:00:03.000Z",
    status: "succeeded",
    runtimeSessionId: "session-chat-1",
    detail: null,
  },
  updatedAt: "2026-11-27T01:00:03.000Z",
};

const sampleHistory: readonly ResidentCeoHistoryEntryRead[] = [
  {
    wakeId: "wake-hb-1",
    cause: "heartbeat",
    requestedAt: "2026-11-27T00:50:00.000Z",
    completedAt: "2026-11-27T00:50:00.000Z",
    status: "succeeded",
    runtimeSessionId: null,
    requestText: null,
    responseText: null,
    detail: "Inbox checked: no open peer requests.",
    execution: { model: "model-one", runtimeInstanceId: "instance-one", permissionMode: "read-only", toolCallCount: 0 },
  },
  {
    wakeId: "wake-peer-1",
    cause: "peer-request",
    requestedAt: "2026-11-27T00:55:00.000Z",
    completedAt: "2026-11-27T00:55:04.000Z",
    status: "succeeded",
    runtimeSessionId: "session-peer-1",
    peerRequestId: "peer_req_42",
    fromPersonId: "person_alice",
    peerSummary: "Investigate edge sync lag",
    requestText: "Please create a task to inspect edge sync lag on node-east.",
    responseText: "Prepared a delegation proposal under task_work_1.",
    detail: null,
    proposalId: "prop_100",
    execution: {
      model: "model-one",
      runtimeInstanceId: "instance-one",
      permissionMode: "read-only",
      toolCallCount: 3,
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
    },
  },
  {
    wakeId: "wake-chat-1",
    cause: "human-chat",
    requestedAt: "2026-11-27T01:00:00.000Z",
    completedAt: "2026-11-27T01:00:03.000Z",
    status: "succeeded",
    runtimeSessionId: "session-chat-1",
    requestText: "Summarize current priorities.",
    responseText: "One peer delegation is waiting for approval.",
    detail: null,
    execution: {
      model: "model-one",
      runtimeInstanceId: "instance-one",
      permissionMode: "read-only",
      toolCallCount: 1,
      inputTokens: 800,
      outputTokens: 150,
      totalTokens: 950,
    },
  },
];

const pendingProposal: ResidentCeoDelegationProposalRead = {
  proposalId: "prop_100",
  peerRequestId: "peer_req_42",
  fromPersonId: "person_alice",
  summary: "Investigate edge sync lag on node-east",
  proposedTitle: "Diagnose edge sync lag on node-east",
  proposedWorkId: "task_work_1",
  proposedAgentId: "neon",
  proposedTargetNodeId: "node-east",
  proposedPrompt: "Check replication lag and report root cause.",
  rationale: "Scoped read-only investigation with concrete target node.",
  wakeId: "wake-peer-1",
  status: "pending_approval",
  approvalMode: null,
  createdAt: "2026-11-27T00:55:04.000Z",
  decidedAt: null,
  decidedByPersonId: null,
  promotedTaskId: null,
  dispatchedTargetNodeId: null,
  dispatchRuntimeSessionId: null,
  dispatchError: null,
  rejectionReason: null,
  gateVerdict: {
    mode: "auto-promote",
    selected: "require_human_approval",
    confidence: 0.72,
    minConfidence: 0.85,
    providerId: "decider-1",
    model: "decider-v1",
    evaluatedAt: "2026-11-27T00:55:05.000Z",
    fallbackReason: "confidence_below_threshold",
  },
  terminalOutcome: null,
};

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function mountCockpit(options?: {
  readonly profile?: ResidentCeoProfileRead | null;
  readonly history?: readonly ResidentCeoHistoryEntryRead[];
  readonly proposals?: readonly ResidentCeoDelegationProposalRead[];
}) {
  const activeProfile = options?.profile === undefined ? phase3Profile : options.profile;
  const activeHistory = options?.history ?? sampleHistory;
  const activeProposals = options?.proposals ?? [pendingProposal];
  api.getResidentCeo.mockResolvedValue({ ok: true, profile: activeProfile });
  api.getResidentCeoHistory.mockResolvedValue({ ok: true, profile: activeProfile, history: activeHistory });
  api.listResidentCeoProposals.mockResolvedValue({ ok: true, profile: activeProfile, proposals: activeProposals });
  api.listInstances.mockResolvedValue({
    instances: [
      {
        instanceId: "instance-one",
        providerId: "openai",
        name: "Local provider",
        enabled: true,
        models: ["model-one", "model-two"],
        defaultModel: "model-one",
      },
    ],
  });
  api.listAgents.mockResolvedValue([{ id: "neon", name: "Neon", role: "worker" }]);
  api.listDecisionProviders.mockResolvedValue([
    { providerId: "decider-1", name: "Decider One", enabled: true, model: "decider-v1", providerType: "decisions" },
  ]);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ResidentCeoView, { repoId: "repo-one" }),
      ),
    );
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (
      queryClient.isFetching() === 0 &&
      container.querySelector('[data-testid="resident-ceo-status"]')?.textContent !== "Not configured"
    )
      break;
  }
  return { container, queryClient };
}

describe("resident CEO client contract validation (N/N-1)", () => {
  it("accepts Phase 1 minimal profile, Phase 2/3 full profile, and unknown additive daemon fields", () => {
    const phase1Legacy = {
      schema: "resident-ceo-profile/v1",
      principalPersonId: "person_owner",
      runtimeInstanceId: "instance-one",
      model: "model-one",
      heartbeatIntervalSec: 300,
      persistentSessionId: null,
      status: "stopped",
      lastWake: null,
      updatedAt: "2026-11-24T00:00:00.000Z",
    };
    expect(isResidentCeoProfile(phase1Legacy)).toBe(true);
    expect(isResidentCeoProfile({ ...phase3Profile, futureAdditiveField: { ok: true } })).toBe(true);
    expect(isResidentCeoProfile({ ...phase1Legacy, schema: "wrong" })).toBe(false);

    expect(readResidentCeoStatusReceipt({ ok: true, profile: phase3Profile, summary: "running" }).profile?.repoId).toBe(
      "repo-one",
    );
    expect(readResidentCeoStatusReceipt({ ok: true, profile: null, summary: "not configured" }).profile).toBeNull();
    expect(
      readResidentCeoHistoryReceipt({ ok: true, profile: phase3Profile, history: sampleHistory }).history,
    ).toHaveLength(3);
    expect(
      readResidentCeoProposalsReceipt({ ok: true, profile: phase3Profile, proposals: [pendingProposal] }).proposals,
    ).toHaveLength(1);
    expect(
      readResidentCeoProposalDecisionReceipt({
        ok: true,
        profile: phase3Profile,
        proposal: { ...pendingProposal, status: "promoted", promotedTaskId: "task_promoted_1" },
        promotedTaskId: "task_promoted_1",
      }).promotedTaskId,
    ).toBe("task_promoted_1");
  });
});

describe("resident CEO cockpit view", () => {
  it("renders status top bar, persisted timeline (human-chat/peer-request/collapsed heartbeat), and expandable execution details", async () => {
    const { container } = await mountCockpit();

    expect(container.querySelector('[data-testid="resident-ceo-status"]')?.textContent).toBe("Running");
    expect(container.querySelector('[data-testid="resident-ceo-instance-model"]')?.textContent).toContain(
      "instance-one · model-one",
    );
    expect(container.querySelector('[data-testid="resident-ceo-policy-badge"]')?.textContent).toContain(
      "Allowlist auto-approve",
    );
    expect(container.querySelector('[data-testid="resident-ceo-gate-badge"]')?.textContent).toContain(
      "auto-promote @ 85%",
    );
    expect(container.querySelector('[data-testid="resident-ceo-config-drawer"]')).toBeNull();

    // Timeline renders human-chat, peer-request (with sender & summary), and collapsed-by-default heartbeat
    const peerEntry = container.querySelector('[data-testid="resident-ceo-entry-wake-peer-1"]');
    expect(peerEntry?.textContent).toContain("person_alice");
    expect(peerEntry?.textContent).toContain("Investigate edge sync lag");
    expect(peerEntry?.textContent).toContain("Prepared a delegation proposal under task_work_1.");

    const chatEntry = container.querySelector('[data-testid="resident-ceo-entry-wake-chat-1"]');
    expect(chatEntry?.textContent).toContain("Summarize current priorities.");
    expect(chatEntry?.textContent).toContain("One peer delegation is waiting for approval.");

    // Heartbeat entry is compact & collapsed by default (details absent until expanded)
    const hbEntry = container.querySelector('[data-testid="resident-ceo-heartbeat-wake-hb-1"]');
    expect(hbEntry?.textContent).toContain("Inbox checked: no open peer requests.");
    expect(container.querySelector('[data-testid="resident-ceo-entry-details-wake-hb-1"]')).toBeNull();

    const hbToggle = container.querySelector(
      '[data-testid="resident-ceo-heartbeat-toggle-wake-hb-1"]',
    ) as HTMLButtonElement;
    await act(async () => {
      hbToggle.click();
    });
    expect(container.querySelector('[data-testid="resident-ceo-entry-details-wake-hb-1"]')?.textContent).toContain(
      "wake-hb-1",
    );

    // Expand execution/tool details on peer-request reply
    expect(container.querySelector('[data-testid="resident-ceo-entry-details-wake-peer-1"]')).toBeNull();
    const detailsToggle = container.querySelector(
      '[data-testid="resident-ceo-entry-details-toggle-wake-peer-1"]',
    ) as HTMLButtonElement;
    await act(async () => {
      detailsToggle.click();
    });
    const details = container.querySelector('[data-testid="resident-ceo-entry-details-wake-peer-1"]');
    expect(details?.textContent).toContain("session-peer-1");
    expect(details?.textContent).toContain("1520");
    expect(details?.textContent).toContain("3");
  });

  it("sends a new message and refreshes the persisted timeline", async () => {
    const { container } = await mountCockpit();
    const updatedHistory: readonly ResidentCeoHistoryEntryRead[] = [
      ...sampleHistory,
      {
        wakeId: "wake-chat-2",
        cause: "human-chat",
        requestedAt: "2026-11-27T01:05:00.000Z",
        completedAt: "2026-11-27T01:05:02.000Z",
        status: "succeeded",
        runtimeSessionId: "session-chat-2",
        requestText: "Review the plan",
        responseText: "The current plan is ready.",
        detail: null,
        execution: { model: "model-one", runtimeInstanceId: "instance-one", permissionMode: "read-only" },
      },
    ];
    api.chatResidentCeo.mockResolvedValue({
      ok: true,
      profile: phase3Profile,
      response: "The current plan is ready.",
    });
    api.getResidentCeoHistory.mockResolvedValue({ ok: true, profile: phase3Profile, history: updatedHistory });

    const input = container.querySelector('input[aria-label="Send message"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input, "Review the plan");
    });
    const form = container.querySelector('[data-testid="resident-ceo-composer"]') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    });

    expect(api.chatResidentCeo).toHaveBeenCalledWith({ repoId: "repo-one", message: "Review the plan" });
    expect(container.querySelector('[data-testid="resident-ceo-entry-response-wake-chat-2"]')?.textContent).toBe(
      "The current plan is ready.",
    );
  });

  it("renders pending approval proposal card with targetNodeId and Decider Gate verdict, and supports approve and reject", async () => {
    const { container } = await mountCockpit();

    const card = container.querySelector('[data-testid="resident-ceo-proposal-prop_100"]');
    expect(card?.textContent).toContain("person_alice");
    expect(card?.textContent).toContain("Investigate edge sync lag on node-east");
    expect(container.querySelector('[data-testid="resident-ceo-proposal-node-prop_100"]')?.textContent).toContain(
      "node-east",
    );
    expect(container.querySelector('[data-testid="resident-ceo-proposal-gate-prop_100"]')?.textContent).toContain(
      "72% / 85%",
    );

    // One-click approve
    api.approveResidentCeoProposal.mockResolvedValue({
      ok: true,
      profile: phase3Profile,
      proposal: { ...pendingProposal, status: "promoted", promotedTaskId: "task_promoted_99" },
      promotedTaskId: "task_promoted_99",
    });
    const approveBtn = container.querySelector('[data-testid="resident-ceo-approve-prop_100"]') as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(api.approveResidentCeoProposal).toHaveBeenCalledWith({
      repoId: "repo-one",
      proposalId: "prop_100",
      workId: "task_work_1",
    });

    // Reject flow with reason
    api.rejectResidentCeoProposal.mockResolvedValue({
      ok: true,
      profile: phase3Profile,
      proposal: { ...pendingProposal, status: "rejected", rejectionReason: "Deferred to next sprint" },
    });
    const rejectBtn = container.querySelector('[data-testid="resident-ceo-reject-prop_100"]') as HTMLButtonElement;
    await act(async () => {
      rejectBtn.click();
    });
    const reasonInput = container.querySelector(
      '[data-testid="resident-ceo-reject-reason-prop_100"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(reasonInput, "Deferred to next sprint");
    });
    const confirmReject = container.querySelector(
      '[data-testid="resident-ceo-confirm-reject-prop_100"]',
    ) as HTMLButtonElement;
    await act(async () => {
      confirmReject.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(api.rejectResidentCeoProposal).toHaveBeenCalledWith({
      repoId: "repo-one",
      proposalId: "prop_100",
      reason: "Deferred to next sprint",
    });
  });

  it("opens the collapsed config drawer and saves Phase 2/3 configuration fields", async () => {
    const { container } = await mountCockpit();
    expect(container.querySelector('[data-testid="resident-ceo-config-drawer"]')).toBeNull();

    const openBtn = container.querySelector('[data-testid="resident-ceo-open-config"]') as HTMLButtonElement;
    await act(async () => {
      openBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(container.querySelector('[data-testid="resident-ceo-config-drawer"]')).not.toBeNull();

    api.configureResidentCeo.mockResolvedValue({ ok: true, profile: phase3Profile });
    const policySelect = container.querySelector('[data-testid="resident-ceo-config-policy"]') as HTMLSelectElement;
    const gateModeSelect = container.querySelector(
      '[data-testid="resident-ceo-config-gate-mode"]',
    ) as HTMLSelectElement;
    const confidenceInput = container.querySelector(
      '[data-testid="resident-ceo-config-gate-confidence"]',
    ) as HTMLInputElement;
    const allowlistInput = container.querySelector('[data-testid="resident-ceo-config-allowlist"]') as HTMLInputElement;

    await act(async () => {
      setInputValue(policySelect, "approval-gated");
      setInputValue(gateModeSelect, "secondary-guard");
      setInputValue(confidenceInput, "0.9");
      setInputValue(allowlistInput, "person_alice, person_bob");
    });

    const saveBtn = container.querySelector('[data-testid="resident-ceo-config-save"]') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(api.configureResidentCeo).toHaveBeenCalledWith({
      repoId: "repo-one",
      runtimeInstanceId: "instance-one",
      model: "model-one",
      heartbeatIntervalSec: 300,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_work_1",
      defaultAgentId: "neon",
      autoApproveSenders: ["person_alice", "person_bob"],
      gateMode: "secondary-guard",
      gateProviderId: "decider-1",
      gateMinConfidence: 0.9,
    });
  });
});
