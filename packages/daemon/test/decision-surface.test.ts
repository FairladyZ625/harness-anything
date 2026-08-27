// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventStore } from "../../kernel/src/index.ts";
// Cold-rebuild internals are intentionally not part of the public kernel barrel.
// eslint-disable-next-line no-restricted-imports
import { readColdRebuildSource } from "../../kernel/src/projection/cold-rebuild-source.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const proposer = {
    actor: { principal: { personId: "person-proposer" }, executor: { kind: "agent", id: "codex" } } as const,
    source: "local" as const,
  },
  arbiter = withRoleBinding(
    { actor: { principal: { personId: "person-arbiter" }, executor: null } as const, source: "local" as const },
    "arbiter",
  );

test("Decision F06 surface preserves amend, transition, relation, repin, validation, distill, and cold rebuild semantics", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-surface-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-surface"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-surface-test",
    now: monotonicClock(),
  });
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-evidence", title: "Decision evidence" }, proposer)).outcome,
      "applied",
    );
    const emptyRepin = await cell.run(
      { kind: "decision-repin", all: true, migrationEvidence: "task/task-evidence/preflight" },
      proposer,
    );
    assert.equal(emptyRepin.outcome, "pending");
    assert.equal(emptyRepin.proof?.canonicalVisible, false);
    const proposed = await cell.run(proposal("Lifecycle surface"), proposer),
      decisionId = receiptJson(proposed).decisionId as string,
      oldIdentity = {
        source: `decision/${decisionId}/C1`,
        target: "task/task-evidence",
        type: "derives" as const,
        direction: "directed" as const,
      },
      oldRelationId = deriveRelationId(oldIdentity);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const amended = await cell.run(
      {
        kind: "decision-amend",
        decisionId,
        title: "Lifecycle surface amended",
        standingPolicy: false,
        fulfillments: [],
        sets: [],
        appends: [
          'chosen:{"id":"CH2","text":"Preserve correction history"}',
          'rejected:{"id":"RJ2","text":"Rewrite in place","whyNot":"It loses history"}',
          'claims:{"id":"C2","text":"Amendments remain reconstructable","loadBearing":false}',
        ],
        loadBearing: { claimId: "C1", value: false },
        body: "\n# Lifecycle surface amended\n\nHuman prose is a separate channel.\n",
      },
      proposer,
    );
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    const bodyAmended = await cell.run(
      {
        kind: "decision-amend",
        decisionId,
        standingPolicy: false,
        fulfillments: [],
        sets: [],
        appends: [],
        body: "\n# Lifecycle surface amended\n\nA second prose correction preserves the first amendment.\n",
      },
      proposer,
    );
    assert.equal(bodyAmended.outcome, "applied", JSON.stringify(bodyAmended));
    assert.equal((receiptJson(bodyAmended) as { amendments: readonly unknown[] }).amendments.length, 2);
    const body = readFileSync(path.join(rootDir, "harness", `decisions/decision-${decisionId}/decision.md`), "utf8");
    assert.match(body, /title: "Lifecycle surface amended"/u);
    assert.match(body, /"id":"CH2"/u);
    assert.match(body, /amendments: \[/u);
    assert.match(body, /contentPins: \[/u);
    assert.match(body, /A second prose correction preserves the first amendment/u);
    const cold = readColdRebuildSource({ rootDir }),
      coldDecision = cold.decisions.find((row) => row.decisionId === decisionId);
    assert.equal(coldDecision?.title, "Lifecycle surface amended");
    assert.equal(coldDecision?.chosen.includes("Preserve correction history"), true);
    assert.equal(
      cold.truth.decisionAnchors
        .find((row) => row.decisionId === decisionId)
        ?.anchorRefs.includes(`decision/${decisionId}/C2`),
      true,
    );
    const beforePreviewRevision = makeTaskEventStore({ repoId: "decision-surface", rootDir }).read().revision,
      preview = await cell.run(
        {
          kind: "decision-amend",
          decisionId,
          title: "Preview only",
          standingPolicy: false,
          fulfillments: [],
          sets: [],
          appends: [],
          dryRun: true,
        },
        proposer,
      );
    assert.equal(preview.outcome, "pending");
    assert.equal(preview.proof?.canonicalVisible, false);
    assert.equal((receiptJson(preview) as { dryRun: boolean }).dryRun, true);
    assert.equal(makeTaskEventStore({ repoId: "decision-surface", rootDir }).read().revision, beforePreviewRevision);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", "decisions/decision-" + decisionId + "/decision.md"), "utf8"),
      body,
    );
    const validated = await cell.run({ kind: "decision-validate", decisionId }, proposer),
      validation = receiptJson(validated) as {
        rows: readonly { readonly valid: boolean; readonly warnings: readonly string[] }[];
        readonly report: { readonly readOnly: boolean };
      };
    assert.equal(validated.outcome, "applied");
    assert.equal(validation.report.readOnly, true);
    assert.equal(validation.rows[0]?.valid, true);
    assert.deepEqual(validation.rows[0]?.warnings, []);
    const accepted = await cell.run(
      {
        kind: "decision-transition",
        targetState: "in_effect",
        decisionId,
        judgmentOnlyRationale: "Independent judgment after reviewing the proposal.",
        standingPolicy: false,
        fulfillments: [{ claimId: "C1", mode: "delivered" }],
      },
      arbiter,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(receiptJson(accepted).state, "in_effect");
    assert.match(
      readFileSync(path.join(rootDir, "harness", `decisions/decision-${decisionId}/decision.md`), "utf8"),
      /## Judgment-only acceptance\n\nIndependent judgment after reviewing the proposal\./u,
    );
    const replacementIdentity = { ...oldIdentity, type: "relates" as const },
      replacementId = deriveRelationId(replacementIdentity),
      replaced = await cell.run(
        {
          kind: "decision-relation-replace",
          decisionId,
          relationId: oldRelationId,
          anchor: "C1",
          relationType: "relates",
          target: "task/task-evidence",
          rationale: "The delivery now records a durable association.",
          body: null,
        },
        proposer,
      );
    assert.equal(replaced.outcome, "applied", JSON.stringify(replaced));
    const replacedEvidence = receiptJson(replaced) as {
      relationReplacement: { readonly retiredRelationId: string; readonly replacementRelationId: string };
    };
    assert.deepEqual(replacedEvidence.relationReplacement, {
      retiredRelationId: oldRelationId,
      replacementRelationId: replacementId,
    });
    const superseded = await cell.run(
      {
        kind: "decision-transition",
        targetState: "superseded",
        decisionId,
        judgmentOnlyRationale: null,
        standingPolicy: false,
        fulfillments: [],
      },
      proposer,
    );
    assert.equal(superseded.outcome, "applied", JSON.stringify(superseded));
    assert.equal(receiptJson(superseded).state, "superseded");
    const terminalRetry = await cell.run(
      {
        kind: "decision-transition",
        targetState: "outcome_retired",
        decisionId,
        judgmentOnlyRationale: null,
        standingPolicy: false,
        fulfillments: [],
      },
      proposer,
    );
    assert.equal(terminalRetry.code, "invalid_transition");
    assert.equal((await cell.run(proposal("Second batch member"), proposer)).outcome, "applied");
    const repinned = await cell.run(
      { kind: "decision-repin", all: true, migrationEvidence: "task/task-evidence/audit-2026-08-15" },
      proposer,
    );
    assert.equal(repinned.outcome, "applied", JSON.stringify(repinned));
    assert.equal((receiptJson(repinned) as { decisionIds: readonly string[] }).decisionIds.length, 2);
    const inputPath = path.join(rootDir, "evidence.md");
    writeFileSync(inputPath, "A stable distilled observation.\nSupporting detail.\n");
    const candidate = await cell.run(
        { kind: "distill-candidate", taskId: "task-evidence", inputPath: "evidence.md" },
        proposer,
      ),
      candidateReport = receiptJson(candidate) as { candidatePath: string; factState: string; factWrite: boolean };
    assert.deepEqual(
      {
        outcome: candidate.outcome,
        canonicalVisible: candidate.proof?.canonicalVisible,
        factState: candidateReport.factState,
        factWrite: candidateReport.factWrite,
      },
      { outcome: "pending", canonicalVisible: false, factState: "candidate", factWrite: false },
    );
    const promoted = await cell.run(
      {
        kind: "distill-promote",
        taskId: "task-evidence",
        candidatePath: candidateReport.candidatePath,
        statement: "A stable distilled observation.",
        factId: "F-DEADBEEF",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: ["abstract_rule"],
      },
      proposer,
    );
    assert.equal(promoted.outcome, "applied", JSON.stringify(promoted));
    assert.equal((promoted as Record<string, unknown>).factId, "F-DEADBEEF");
    assert.match(
      readFileSync(path.join(rootDir, "harness/tasks/task-evidence-decision-evidence/facts.md"), "utf8"),
      /### F-DEADBEEF/u,
    );
    const events = makeTaskEventStore({ repoId: "decision-surface", rootDir })
      .read()
      .events.filter((event) => event.schema === "decision-event/v1");
    assert.equal(events.filter((event) => event.type === "decision_amended").length, 2);
    assert.equal(
      events.some((event) => event.type === "decision_relation_replaced"),
      true,
    );
    assert.equal(events.filter((event) => event.type === "decision_repinned").length, 2);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function proposal(title: string) {
  return {
    kind: "decision-propose",
    jsonInput: JSON.stringify({
      title,
      question: "Should the full Decision lifecycle use immutable events?",
      riskTier: "medium",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Use immutable events" }],
      rejected: [{ id: "RJ1", text: "Rewrite files", whyNot: "It loses event history" }],
      claims: [{ id: "C1", text: "The task provides evidence.", loadBearing: true }],
      fulfillments: [],
      relations: [
        {
          anchor: "C1",
          type: "derives",
          target: "task/task-evidence",
          rationale: "The Decision owns the evidence delivery.",
        },
      ],
    }),
  } as const;
}
function receiptJson(receipt: { readonly evidence?: string }): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}
function monotonicClock(): () => string {
  let second = 0;
  return () => `2026-08-15T00:00:${String(second++).padStart(2, "0")}.000Z`;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Decision Surface Test");
  git(rootDir, "config", "user.email", "decision-surface@example.invalid");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
