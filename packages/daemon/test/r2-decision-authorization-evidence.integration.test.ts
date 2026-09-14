// harness-test-tier: integration
// Evidence only (task_d437aea6d5e724195c5d65e6ec stage 1): walks the real CLI parser and the
// GUI daemon-side action synthesis into the real RepoCell queue authorization → executor →
// canonical acceptance chain, under a repo-write-only declared binding and an arbiter binding.
// No production behavior is asserted as correct; this file documents the current divergence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type ActorIdentity } from "../../kernel/src/index.ts";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { actionForDaemonMethod, commandClassForAction } from "../src/protocol/daemon-protocol-commands.ts";
import { declaredRoleBindingsForActor } from "../src/identity/declared-role-binding-projection.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";

const repoWriteJudgeId = "person_r2_repo_write",
  arbiterJudgeId = "person_r2_arbiter",
  dualJudgeId = "person_r2_dual",
  proposerAgent: ActorIdentity = {
    principal: { personId: "person_r2_proposer" },
    executor: { kind: "agent", id: "r2-proposer-agent" },
  };

test("decision adjudication entries through the real chain: entry × binding matrix", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-r2-decision-auth-"));
  initRepo(rootDir);
  writePeopleRoster(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("r2-decision-auth"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "r2-decision-auth-test",
  });
  const reader = makeTaskEventReader({ repoId: "r2-decision-auth", rootDir });
  try {
    const proposerBinding = declaredBinding(rootDir, proposerAgent),
      repoWriteBinding = declaredBinding(rootDir, { principal: { personId: repoWriteJudgeId }, executor: null }),
      arbiterBinding = declaredBinding(rootDir, { principal: { personId: arbiterJudgeId }, executor: null });

    // Structural receipt: the two same-semantics entries sit in different command classes.
    assert.deepEqual(
      { accept: commandClassForAction("decision-accept"), transition: commandClassForAction("decision-transition") },
      { accept: "arbiter", transition: "repo-write" },
    );

    const d1 = await propose(cell, reader, proposerBinding, "R2 matrix cli accept"),
      d2 = await propose(cell, reader, proposerBinding, "R2 matrix gui accept"),
      d3 = await propose(cell, reader, proposerBinding, "R2 matrix transition"),
      d4 = await propose(cell, reader, proposerBinding, "R2 matrix reject pair"),
      d5 = await propose(cell, reader, proposerBinding, "R2 matrix arbiter accept"),
      d6 = await propose(cell, reader, proposerBinding, "R2 matrix arbiter transition");

    // 1. CLI `decision accept` under a repo-write-only declared binding: denied.
    const cliAccept = cliAction([
      "decision",
      "accept",
      d1.decisionId,
      "--rationale",
      "repo-write only judge",
      "--judgment-only",
      "matrix evidence",
    ]);
    assert.equal(cliAccept.kind, "decision-accept");
    assertDeniedBeforeAcceptance("cli accept / repo-write", await cell.run(cliAccept, repoWriteBinding), reader);

    // 2. GUI `decision.accept` (daemon-side synthesis) under the same binding: same denial.
    const guiAccept = actionForDaemonMethod("repo.decision.accept", {
      decisionId: d2.decisionId,
      rationale: "repo-write only judge",
      judgmentOnlyRationale: "matrix evidence",
    });
    assert.equal(guiAccept.kind, "decision-accept");
    assertDeniedBeforeAcceptance("gui accept / repo-write", await cell.run(guiAccept, repoWriteBinding), reader);

    // Accepted writes take revisions strictly in sequence: the first judgment after the six
    // proposals sits at d6.revision + 1, and each later judgment adds exactly one. The denied
    // attempts in between therefore provably consumed no canonical revision.
    let nextRevision = d6.revision + 1;
    const judgeAt = (label: string, receipt: { readonly opId: string } & Record<string, unknown>) => {
      const event = acceptedEventOf(label, receipt, reader, nextRevision);
      nextRevision += 1;
      return event;
    };

    // 3. CLI `decision transition in_effect` under the same binding: accepted, and it compiles
    //    the same adjudication event type the two denied entries above were trying to produce.
    const transition = cliAction([
      "decision",
      "transition",
      "in_effect",
      d3.decisionId,
      "--judgment-only",
      "matrix evidence",
    ]);
    assert.equal(transition.kind, "decision-transition");
    assert.deepEqual(judgeAt("transition in_effect / repo-write", await cell.run(transition, repoWriteBinding)), {
      schema: "decision-event/v1",
      type: "decision_accepted",
    });

    // 4. Same decision, same binding: the reject alias is denied, the transition is accepted.
    const cliReject = cliAction(["decision", "reject", d4.decisionId, "--rationale", "repo-write only judge"]);
    assert.equal(cliReject.kind, "decision-reject");
    assertDeniedBeforeAcceptance("cli reject / repo-write", await cell.run(cliReject, repoWriteBinding), reader);
    const transitionRejected = await cell.run(
      cliAction(["decision", "transition", "rejected", d4.decisionId]),
      repoWriteBinding,
    );
    assert.deepEqual(judgeAt("transition rejected / repo-write", transitionRejected), {
      schema: "decision-event/v1",
      type: "decision_rejected",
    });

    // 5. Arbiter-qualified binding: the accept alias succeeds…
    const arbiterAccept = await cell.run(
      cliAction([
        "decision",
        "accept",
        d5.decisionId,
        "--rationale",
        "arbiter judge",
        "--judgment-only",
        "matrix evidence",
      ]),
      arbiterBinding,
    );
    assert.deepEqual(judgeAt("cli accept / arbiter", arbiterAccept), {
      schema: "decision-event/v1",
      type: "decision_accepted",
    });
    // 6. …but the same arbiter-only binding cannot run the canonical transition command at all:
    //    decision-transition sits in the repo-write rule, so the divergence is bidirectional.
    const arbiterTransition = await cell.run(
      cliAction(["decision", "transition", "in_effect", d6.decisionId, "--judgment-only", "matrix evidence"]),
      arbiterBinding,
    );
    assertDeniedBeforeAcceptance("transition in_effect / arbiter", arbiterTransition, reader);

    // 7. A dual-role binding (the production owner shape: repo-write + arbiter) runs both entries.
    const dualBinding = declaredBinding(rootDir, { principal: { personId: dualJudgeId }, executor: null }),
      d7 = await propose(cell, reader, proposerBinding, "R2 matrix dual judge");
    nextRevision = d7.revision + 1;
    const dualAccept = await cell.run(
      cliAction([
        "decision",
        "accept",
        d7.decisionId,
        "--rationale",
        "dual-role judge",
        "--judgment-only",
        "matrix evidence",
      ]),
      dualBinding,
    );
    assert.deepEqual(judgeAt("cli accept / dual role", dualAccept), {
      schema: "decision-event/v1",
      type: "decision_accepted",
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
  expectedRevision: number,
): { readonly schema: string; readonly type: string } {
  assert.equal(receipt.outcome, "applied", `${label}: ${JSON.stringify(receipt)}`);
  const event = reader.readEvent(receipt.opId);
  assert.ok(event, `${label}: accepted op ${receipt.opId} has no canonical event`);
  // The caller hands the next expected revision; a denied attempt never reaches here, so any
  // gap would mean a denial was accepted canonically or an acceptance consumed two revisions.
  assert.equal(
    event.workspaceRevision,
    expectedRevision,
    `${label}: expected the judgment at revision ${expectedRevision}`,
  );
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
            displayName: "R2 Proposer",
            roles: ["contributor"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:r2-evidence", subject: "1" }],
          },
          {
            personId: repoWriteJudgeId,
            displayName: "R2 Repo Write Judge",
            roles: ["contributor"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:r2-evidence", subject: "2" }],
          },
          {
            personId: arbiterJudgeId,
            displayName: "R2 Arbiter Judge",
            roles: ["judge"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:r2-evidence", subject: "3" }],
          },
          {
            personId: dualJudgeId,
            displayName: "R2 Dual Role Judge",
            roles: ["contributor", "judge"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:r2-evidence", subject: "4" }],
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
  execFileSync("git", ["-C", rootDir, "config", "user.name", "R2 Decision Auth Evidence"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "r2-evidence@example.invalid"]);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", rootDir, "add", "."]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "base"]);
}
