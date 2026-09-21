// harness-test-tier: integration
// Regression (task_d437aea6d5e724195c5d65e6ec stage 2, CEO ruling: transition narrowed to
// bookkeeping): decision accept/reject/defer are the only adjudication entries and CLI and GUI
// share one Policy qualification for them; decision transition compiles only superseded and
// outcome_retired, so judgment targets are parameter errors at the CLI parser and at the kernel
// compiler — never authorization verdicts — while the bookkeeping targets stay repo-write work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type ActorIdentity } from "@harness-anything/kernel";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { actionForDaemonMethod, commandClassForAction } from "../src/protocol/daemon-protocol-commands.ts";
import { declaredRoleBindingsForActor } from "../src/identity/declared-role-binding-projection.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";

const repoWriteJudgeId = "person_r2_repo_write",
  arbiterJudgeId = "person_r2_arbiter",
  proposerAgent: ActorIdentity = {
    principal: { personId: "person_r2_proposer" },
    executor: { kind: "agent", id: "r2-proposer-agent" },
  };

test("adjudication entries share one qualification and transition judgment targets are parameter errors", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-entry-parity-"));
  initRepo(rootDir);
  writePeopleRoster(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-entry-parity"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-entry-parity-test",
  });
  const reader = makeTaskEventReader({ repoId: "decision-entry-parity", rootDir });
  try {
    const proposerBinding = declaredBinding(rootDir, proposerAgent),
      repoWriteBinding = declaredBinding(rootDir, { principal: { personId: repoWriteJudgeId }, executor: null }),
      arbiterBinding = declaredBinding(rootDir, { principal: { personId: arbiterJudgeId }, executor: null });

    // The two families keep their ruling tiers: adjudication is arbiter work, bookkeeping is
    // repo-write work. This tier split is the load-bearing decision the entry parity builds on.
    assert.deepEqual(
      {
        accept: commandClassForAction("decision-accept"),
        reject: commandClassForAction("decision-reject"),
        defer: commandClassForAction("decision-defer"),
        transition: commandClassForAction("decision-transition"),
      },
      { accept: "arbiter", reject: "arbiter", defer: "arbiter", transition: "repo-write" },
    );

    const d1 = await propose(cell, reader, proposerBinding, "parity cli accept under repo-write"),
      d2 = await propose(cell, reader, proposerBinding, "parity gui accept under repo-write"),
      d3 = await propose(cell, reader, proposerBinding, "parity cli accept under arbiter"),
      d4 = await propose(cell, reader, proposerBinding, "parity gui accept under arbiter"),
      d5 = await propose(cell, reader, proposerBinding, "parity transition targets");

    // 1. Same repo-write binding, both adjudication entries: one denial shape.
    const cliAccept = cliAction([
      "decision",
      "accept",
      d1.decisionId,
      "--rationale",
      "repo-write only judge",
      "--judgment-only",
      "parity regression",
    ]);
    assert.equal(cliAccept.kind, "decision-accept");
    assertDeniedBeforeAcceptance("cli accept / repo-write", await cell.run(cliAccept, repoWriteBinding), reader);
    const guiAccept = actionForDaemonMethod("repo.decision.accept", {
      decisionId: d2.decisionId,
      rationale: "repo-write only judge",
      judgmentOnlyRationale: "parity regression",
    });
    assert.equal(guiAccept.kind, "decision-accept");
    assertDeniedBeforeAcceptance("gui accept / repo-write", await cell.run(guiAccept, repoWriteBinding), reader);

    // 2. Same arbiter binding, both entries: one acceptance shape, same event type.
    const arbiterCli = await cell.run(
      cliAction([
        "decision",
        "accept",
        d3.decisionId,
        "--rationale",
        "arbiter judge",
        "--judgment-only",
        "parity regression",
      ]),
      arbiterBinding,
    );
    assert.deepEqual(acceptedEventOf("cli accept / arbiter", arbiterCli, reader), {
      schema: "decision-event/v1",
      type: "decision_accepted",
    });
    const arbiterGui = await cell.run(
      actionForDaemonMethod("repo.decision.accept", {
        decisionId: d4.decisionId,
        rationale: "arbiter judge",
        judgmentOnlyRationale: "parity regression",
      }),
      arbiterBinding,
    );
    assert.deepEqual(acceptedEventOf("gui accept / arbiter", arbiterGui, reader), {
      schema: "decision-event/v1",
      type: "decision_accepted",
    });

    // 3. Transition judgment targets are parameter errors at the CLI parser…
    for (const targetState of ["in_effect", "rejected", "deferred"]) {
      const parsed = parseThinCommand(["decision", "transition", targetState, d5.decisionId]);
      assert.equal(parsed.ok, false, targetState);
      if (!parsed.ok) assert.equal(parsed.code, "invalid_field", targetState);
    }
    // …and at the daemon layer: a binding that is fully authorized for transition work still
    // gets op_rejected/invalid_command — the rejection is the target, not the qualification.
    for (const targetState of ["in_effect", "rejected", "deferred"]) {
      const attempted = await cell.run(
        { kind: "decision-transition", decisionId: d5.decisionId, targetState },
        repoWriteBinding,
      );
      assert.deepEqual(
        { outcome: attempted.outcome, code: attempted.code, canonicalEvent: reader.readEvent(attempted.opId) },
        { outcome: "op_rejected", code: "invalid_command", canonicalEvent: null },
        `transition ${targetState} / repo-write: expected a compile-level parameter rejection`,
      );
    }

    // 4. The bookkeeping targets remain repo-write work end to end: adjudicate with the arbiter
    // entry, then supersede with the repo-write-only binding.
    const accepted = await cell.run(
      cliAction([
        "decision",
        "accept",
        d5.decisionId,
        "--rationale",
        "arbiter judge",
        "--judgment-only",
        "parity regression",
      ]),
      arbiterBinding,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const superseded = await cell.run(
      { kind: "decision-transition", decisionId: d5.decisionId, targetState: "superseded" },
      repoWriteBinding,
    );
    assert.deepEqual(acceptedEventOf("transition superseded / repo-write", superseded, reader), {
      schema: "decision-event/v1",
      type: "decision_superseded",
    });
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** The production `deriveLocalBinding` shape (daemon-host-binding.ts): declared mode + roster-projected roles. */
function declaredBinding(rootDir: string, actor: ActorIdentity) {
  return {
    actor,
    source: "local" as const,
    authorizationBindingMode: "declared" as const,
    roleBindings: declaredRoleBindingsForActor(canonicalRoot(rootDir), actor)!,
  };
}

function cliAction(argv: readonly string[]): Record<string, unknown> & { readonly kind: string } {
  const parsed = parseThinCommand(argv);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(`parse failed: ${JSON.stringify(parsed)}`);
  return parsed.command.action as Record<string, unknown> & { readonly kind: string };
}

async function propose(
  cell: RepoCell,
  reader: ReturnType<typeof makeTaskEventReader>,
  binding: ReturnType<typeof declaredBinding>,
  title: string,
): Promise<{ readonly decisionId: string; readonly revision: number }> {
  const proposed = await cell.run(
    {
      kind: "decision-propose",
      body: realizedDecisionBody(title),
      jsonInput: JSON.stringify({
        title,
        question: "Does the entry point change the Policy qualification?",
        riskTier: "medium",
        urgency: "medium",
        vertical: "software/coding",
        preset: "decision-conformance",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "One adjudication semantics" }],
        rejected: [{ id: "RJ1", text: "Entry-specific roles", whyNot: "It forks the same judgment" }],
        claims: [],
        fulfillments: [],
      }),
    },
    binding,
  );
  assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
  const decisionId = String(JSON.parse(String(proposed.evidence)).decisionId),
    event = reader.readEvent(proposed.opId);
  assert.ok(event, `proposal ${proposed.opId} has no canonical event`);
  return { decisionId, revision: event.workspaceRevision };
}

function assertDeniedBeforeAcceptance(
  label: string,
  receipt: { readonly opId: string } & Record<string, unknown>,
  reader: ReturnType<typeof makeTaskEventReader>,
): void {
  const decision = receipt.authorizationDecision as
    | { readonly outcome: string; readonly reasonCodes: readonly string[] }
    | undefined;
  assert.deepEqual(
    {
      outcome: receipt.outcome,
      code: receipt.code,
      authorizationOutcome: decision?.outcome,
      reasonCodes: decision?.reasonCodes,
      canonicalEvent: reader.readEvent(receipt.opId),
      acceptance: receipt.acceptance,
    },
    {
      outcome: "op_rejected",
      code: "authorization_denied",
      authorizationOutcome: "denied",
      reasonCodes: ["authorization_predicate_failed"],
      canonicalEvent: null,
      acceptance: null,
    },
    `${label}: expected a queue-level Policy denial with no canonical acceptance`,
  );
}

function acceptedEventOf(
  label: string,
  receipt: { readonly opId: string } & Record<string, unknown>,
  reader: ReturnType<typeof makeTaskEventReader>,
): { readonly schema: string; readonly type: string } {
  assert.equal(receipt.outcome, "applied", `${label}: ${JSON.stringify(receipt)}`);
  const event = reader.readEvent(receipt.opId);
  assert.ok(event, `${label}: accepted op ${receipt.opId} has no canonical event`);
  return { schema: event.schema, type: event.type };
}

function writePeopleRoster(rootDir: string): void {
  writeFileSync(
    path.join(rootDir, "harness", "people.yaml"),
    JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: proposerAgent.principal.personId,
            displayName: "Parity Proposer",
            roles: ["contributor"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:entry-parity", subject: "1" }],
          },
          {
            personId: repoWriteJudgeId,
            displayName: "Parity Repo Write Judge",
            roles: ["contributor"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:entry-parity", subject: "2" }],
          },
          {
            personId: arbiterJudgeId,
            displayName: "Parity Arbiter Judge",
            roles: ["judge"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:entry-parity", subject: "3" }],
          },
        ],
        roles: [
          { roleId: "contributor", commandClasses: ["repo-write", "repo-read"] },
          { roleId: "judge", commandClasses: ["arbiter", "repo-read"] },
        ],
      },
      null,
      2,
    ),
  );
}

function initRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Decision Entry Parity Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "entry-parity@example.invalid"]);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", rootDir, "add", "."]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "base"]);
}
