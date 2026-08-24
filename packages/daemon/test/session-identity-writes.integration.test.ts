// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalEventWritePlan,
  makeTaskEventStore,
  type AgentRuntimeEventV1,
  type SessionProvenanceV1,
} from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const runtimeSessionId = "runtime-session-identity",
  providerSessionId = "01a02711-fb92-7ae2-b5bc-76c9b7154ead",
  transcriptRef =
    "file:.harness/runtime/dispatches/dispatch_5beaecffdf966066d2816b0d.jsonl";
const runtimeBinding = {
  actor: {
    principal: { personId: "person-runtime" },
    executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
  } as const,
  source: "local" as const,
};
const humanBinding = {
  actor: { principal: { personId: "person-human" }, executor: null } as const,
  source: "local" as const,
};

test("task create, fact record, and decision propose project the canonical runtime session identity", async () => {
  const rootDir = mkdtempSync(
    path.join(tmpdir(), "ha-session-identity-writes-"),
  );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    seedRuntime(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("session-identity-writes"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "session-identity-writes",
      now: monotonicClock(),
    });
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task-session-identity",
            title: "Session identity",
          },
          runtimeBinding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId: "task-session-identity",
            factId: "F-A1B2C3D4",
            statement: "Writes retain the provider session identity.",
            evidenceSource: "captured-provider-session",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: ["pattern"],
          },
          runtimeBinding,
        )
      ).outcome,
      "applied",
    );
    const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Retain session identity",
          question:
            "Should authored writes retain the canonical runtime session?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Retain it" }],
          rejected: [
            {
              id: "RJ1",
              text: "Fabricate an id",
              whyNot: "It would not address the provider session",
            },
          ],
          claims: [],
          fulfillments: [],
          relations: [],
        }),
      },
      runtimeBinding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = String(receiptEvidence(proposed).decisionId);

    const task = receiptEvidence(
      await cell.run(
        { kind: "task-show", taskId: "task-session-identity" },
        runtimeBinding,
      ),
    ).task as { readonly provenance: readonly SessionProvenanceV1[] };
    const fact = receiptEvidence(
      await cell.run(
        {
          kind: "fact-show",
          taskId: "task-session-identity",
          factId: "F-A1B2C3D4",
        },
        runtimeBinding,
      ),
    ).fact as { readonly provenance: readonly SessionProvenanceV1[] };
    const decision = receiptEvidence(
      await cell.run({ kind: "decision-show", decisionId }, runtimeBinding),
    ).decision as { readonly provenance: readonly SessionProvenanceV1[] };
    for (const provenance of [
      task.provenance,
      fact.provenance,
      decision.provenance,
    ])
      assert.deepEqual(withoutBoundAt(provenance), [
        {
          runtime: "codex",
          sessionId: providerSessionId,
          transcriptReachability: "dispatch_stream_only",
        },
      ]);

    const runtime = (
      await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId })
    ).session;
    assert.equal(runtime.providerSessionId, providerSessionId);
    const auditStore = makeTaskEventStore({
        repoId: "session-identity-writes",
        rootDir,
      }),
      providerBound = auditStore.readEvent("op-runtime-4");
    assert.equal(providerBound?.type, "runtime_session_provider_bound");
    if (providerBound?.type === "runtime_session_provider_bound")
      assert.equal(providerBound.payload.transcriptRef, transcriptRef);
    await auditStore.drain();

    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task-session-unavailable",
            title: "Unavailable session",
          },
          humanBinding,
        )
      ).outcome,
      "applied",
    );
    const unavailable = receiptEvidence(
      await cell.run(
        { kind: "task-show", taskId: "task-session-unavailable" },
        humanBinding,
      ),
    ).task as { readonly provenance: readonly SessionProvenanceV1[] };
    assert.deepEqual(withoutBoundAt(unavailable.provenance), [
      {
        runtime: "unavailable",
        sessionId: null,
        transcriptReachability: "unavailable",
      },
    ]);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function seedRuntime(rootDir: string): void {
  const store = makeTaskEventStore({
    repoId: "session-identity-writes",
    rootDir,
  });
  for (const event of runtimeEvents())
    store.append({
      event,
      plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
      blobs: [],
    });
}
function runtimeEvents(): readonly AgentRuntimeEventV1[] {
  const common = (revision: number) => ({
    schema: "agent-runtime-event/v1" as const,
    eventId: `event-runtime-${revision}`,
    workspaceRevision: revision,
    opId: `op-runtime-${revision}`,
    actor: humanBinding.actor,
    source: humanBinding.source,
    occurredAt: `2026-08-23T00:00:0${revision}.000Z`,
  });
  return [
    {
      ...common(1),
      type: "runtime_installation_observed",
      payload: {
        installationId: "installation-codex",
        kindId: "codex",
        protocolFamily: "codex",
        hostRef: "host:local",
        version: "1.0.0",
        discoverySource: "wrapper",
        capabilities: [
          "structured_witness",
          "resume",
          "attach",
          "session_identity",
        ],
      },
    },
    {
      ...common(2),
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId: "dispatch_5beaecffdf966066d2816b0d",
        runtimeSessionId,
        instanceId: "test-codex-sol",
        installationId: "installation-codex",
        kindId: "codex",
        idempotencyKey: "session-identity-once",
        definitionSnapshotRef: "artifact:runtime-definition/session-identity",
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "test-codex-sol",
          installationId: "installation-codex",
          kindId: "codex",
          providerId: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          baseUrl: null,
          authMode: "subscription",
        },
      },
    },
    {
      ...common(3),
      type: "runtime_session_started",
      payload: {
        runtimeSessionId,
        instanceId: "test-codex-sol",
        installationId: "installation-codex",
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definition/session-identity",
        launchGeneration: 1,
        attachable: true,
      },
    },
    {
      ...common(4),
      type: "runtime_session_provider_bound",
      payload: { runtimeSessionId, providerSessionId, transcriptRef },
    },
  ] as readonly AgentRuntimeEventV1[];
}
function receiptEvidence(receipt: {
  readonly evidence?: string;
}): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}
function withoutBoundAt(
  value: readonly SessionProvenanceV1[],
): readonly Omit<SessionProvenanceV1, "boundAt">[] {
  return value.map(({ boundAt: _boundAt, ...identity }) => identity);
}
function monotonicClock(): () => string {
  let second = 10;
  return () => `2026-08-23T00:00:${String(second++).padStart(2, "0")}.000Z`;
}
function initRepo(rootDir: string): void {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Session Identity Test");
  git(rootDir, "config", "user.email", "session-identity@example.invalid");
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
