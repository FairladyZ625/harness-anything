// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { canonicalRoot, workspaceId, type DaemonAgendaResult } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-agenda" }, executor: { kind: "agent", id: "codex-sol" } } as const;
const binding = { actor, source: "local" as const };

test("agenda projects an empty ledger without synthetic state", async () => {
  await withCell("agenda-empty", async (cell) => {
    const agenda = await cell.read("repo.agenda.read");
    assert.deepEqual({ inFlight: agenda.inFlight, awaitingDecision: agenda.awaitingDecision, waitingOnOthers: agenda.waitingOnOthers, dispatchable: agenda.dispatchable }, { inFlight: [], awaitingDecision: [], waitingOnOthers: [], dispatchable: [] });
    assert.match(agenda.summary, /在飞线 \(0\)[\s\S]*待裁 \(0\)[\s\S]*球在别人手里 \(0\)[\s\S]*可派队列 \(0\)/u);
  });
});

test("agenda derives all four groups, pins first, and rejects a missing task pin", async () => {
  await withCell("agenda-four-groups", async (cell, rootDir) => {
    for (const [taskId, title] of [["task_active", "Active pinned"], ["task_dispatch", "Dispatch"], ["task_dispatch_pinned", "Dispatch pinned"], ["task_blocked", "Explicitly blocked"], ["task_wait", "Waits on dependency"], ["task_dependency", "Dependency"], ["task_review", "Review pending"]] as const) assert.equal((await cell.run({ kind: "task-create", taskId, title }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_active", executionId: "exe_active" }, binding)).outcome, "applied");
    const activePin = await cell.run({ kind: "task-amend", taskId: "task_active", patches: [{ field: "pinned", value: "true" }] }, binding);
    assert.equal(activePin.outcome, "applied", JSON.stringify(activePin));
    assert.equal((await cell.run({ kind: "task-amend", taskId: "task_dispatch_pinned", patches: [{ field: "pinned", value: "true" }] }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_blocked", status: "blocked", reason: "Waiting on another team" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-relate", taskId: "task_wait", target: "task/task_dependency", relationType: "depends-on", rationale: "Dependency must finish first" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_review", executionId: "exe_review" }, binding)).outcome, "applied");
    const reviewCommitSha = git(rootDir, "rev-parse", "HEAD"); assert.equal((await cell.run({ kind: "task-submit", taskId: "task_review", executionId: "exe_review", submission: { completionClaim: "Agenda fixture is ready.", deliverables: ["agenda projection"], outputs: ["daemon agenda"], verificationNotes: ["integration test"], knownGaps: [], residualRisks: [], commitSha: reviewCommitSha } }, binding)).outcome, "applied");
    const proposed = await cell.run(decisionProposal(), binding); assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));

    const missing = await cell.run({ kind: "task-amend", taskId: "task_missing", patches: [{ field: "pinned", value: "true" }] }, binding);
    assert.deepEqual({ outcome: missing.outcome, code: missing.code }, { outcome: "op_rejected", code: "task_not_found" });

    const agenda = await cell.read("repo.agenda.read", { limit: 50 });
    assert.deepEqual(agenda.inFlight.map(({ taskId }) => taskId), ["task_active"]);
    assert.equal(agenda.inFlight[0]?.pinned, true); assert.equal(agenda.inFlight[0]?.leaseExecutionId, "exe_active");
    assert.equal(agenda.awaitingDecision.some((row) => row.kind === "execution" && row.executionId === "exe_review"), true);
    assert.equal(agenda.awaitingDecision.some((row) => row.kind === "decision"), true);
    assert.equal(agenda.waitingOnOthers.some(({ taskId }) => taskId === "task_blocked"), true);
    assert.deepEqual(agenda.waitingOnOthers.find(({ taskId }) => taskId === "task_wait")?.blockingAssessment.blockers.map(({ targetTaskId }) => targetTaskId), ["task_dependency"]);
    assert.equal(agenda.dispatchable[0]?.taskId, "task_dispatch_pinned"); assert.equal(agenda.dispatchable[0]?.pinned, true);
    assert.equal(agenda.dispatchable.some(({ taskId }) => taskId === "task_wait"), false);
    assert.match(agenda.summary, /📌 task_active[\s\S]*待裁[\s\S]*球在别人手里[\s\S]*📌 task_dispatch_pinned/u);
    const reviewerBinding = { actor: { principal: { personId: "person-agenda-reviewer" }, executor: { kind: "agent" as const, id: "agenda-reviewer" } }, source: "local" as const, roles: ["$arbiter"] };
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "dismissed", reason: "Superseded opinion.", evidenceChecked: ["agenda"] })); assert.equal((await cell.run({ kind: "task-review-execution", taskId: "task_review", executionId: "exe_review", reviewId: "review-dismissed", fromFile: "review.json" }, reviewerBinding)).outcome, "applied");
    assert.equal((await cell.read("repo.agenda.read", { limit: 50 })).awaitingDecision.some((row) => row.kind === "execution" && row.executionId === "exe_review"), true, "dismissed history must not remove the execution from review work");
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Current opinion.", evidenceChecked: ["agenda"] })); assert.equal((await cell.run({ kind: "task-review-execution", taskId: "task_review", executionId: "exe_review", reviewId: "review-approved", fromFile: "review.json" }, reviewerBinding)).outcome, "applied");
    assert.equal((await cell.read("repo.agenda.read", { limit: 50 })).awaitingDecision.some((row) => row.kind === "execution" && row.executionId === "exe_review"), false, "an approved current-cut Review resolves review work even when dismissed history remains");
    const contract = JSON.parse(readFileSync(path.join(rootDir, "harness/tasks/task_active-active-pinned/task-contract.json"), "utf8")) as { pinned?: boolean };
    assert.equal(contract.pinned, true);

    let page: DaemonAgendaResult = await cell.read("repo.agenda.read", { limit: 1 }); const dispatchable = [...page.dispatchable];
    assert.equal(page.dispatchable[0]?.taskId, "task_dispatch_pinned", "a pinned task must lead the first planned source page");
    while (page.page.nextCursor) { page = await cell.read("repo.agenda.read", { limit: 1, cursor: page.page.nextCursor }); dispatchable.push(...page.dispatchable); }
    assert.equal(new Set(dispatchable.map(({ taskId }) => taskId)).has("task_dispatch"), true, "the composite cursor must eventually expose unpinned dispatchable tasks");
  });
});

test("agenda projects an all-blocked ledger only into the waiting group", async () => {
  await withCell("agenda-all-blocked", async (cell) => {
    for (const taskId of ["task_blocked_a", "task_blocked_b"] as const) { await cell.run({ kind: "task-create", taskId, title: taskId }, binding); await cell.run({ kind: "task-transition", taskId, status: "blocked", reason: "External wait" }, binding); }
    const agenda = await cell.read("repo.agenda.read");
    assert.deepEqual(agenda.waitingOnOthers.map(({ taskId }) => taskId), ["task_blocked_a", "task_blocked_b"]);
    assert.deepEqual({ inFlight: agenda.inFlight, awaitingDecision: agenda.awaitingDecision, dispatchable: agenda.dispatchable }, { inFlight: [], awaitingDecision: [], dispatchable: [] });
  });
});

test("task pin and unpin reuse amend events and update agenda order", async () => {
  await withCell("agenda-pin-command", async (cell, rootDir) => {
    for (const taskId of ["task_a", "task_z"] as const) assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
    const runCli = (argv: readonly string[]) => {
      const parsed = parseThinCommand(argv);
      assert.equal(parsed.ok, true, argv.join(" "));
      if (!parsed.ok) throw new Error(parsed.nextAction);
      return cell.run(parsed.command.action as Parameters<typeof cell.run>[0], binding);
    };
    const eventFor = (opId: string) => makeTaskEventStore({ repoId: "agenda-pin-command", rootDir }).readEvent(opId), pin = await runCli(["task", "pin", "task_z"]);
    assert.equal(pin.outcome, "applied", JSON.stringify(pin));
    const pinEvent = pinnedAmendEvent(eventFor(pin.opId));
    assert.deepEqual(pinEvent, { type: "task_amended", command: "amend", fields: ["pinned"], pinned: true });
    assert.deepEqual((await cell.read("repo.agenda.read")).dispatchable.map(({ taskId }) => taskId), ["task_z", "task_a"]);

    const unpin = await runCli(["task", "unpin", "task_z"]);
    assert.equal(unpin.outcome, "applied", JSON.stringify(unpin));
    assert.deepEqual(pinnedAmendEvent(eventFor(unpin.opId)), { type: "task_amended", command: "amend", fields: ["pinned"], pinned: false });
    const shown = await runCli(["task", "show", "task_z"]);
    assert.match(String(shown.evidence), /"pinned":false/u);
    assert.deepEqual((await cell.read("repo.agenda.read")).dispatchable.map(({ taskId }) => taskId), ["task_a", "task_z"]);

    const amend = await runCli(["task", "amend", "task_z", "--set", "pinned:true"]);
    assert.equal(amend.outcome, "applied", JSON.stringify(amend));
    assert.deepEqual(pinnedAmendEvent(eventFor(amend.opId)), pinEvent);
  });
});

test("terminal task transitions clear pins without changing unpinned task outcomes", async () => {
  await withCell("agenda-terminal-pin", async (cell) => {
    for (const taskId of ["task_pinned", "task_plain"] as const) assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-amend", taskId: "task_pinned", patches: [{ field: "pinned", value: "true" }] }, binding)).outcome, "applied");

    const cancel = (taskId: "task_pinned" | "task_plain") => cell.run({ kind: "task-transition", taskId, status: "cancelled", reason: "Terminal pin fixture", force: true }, binding);
    const pinned = await cancel("task_pinned"), plain = await cancel("task_plain");
    assert.equal(pinned.outcome, "applied", JSON.stringify(pinned)); assert.equal(plain.outcome, "applied", JSON.stringify(plain));
    assert.deepEqual((await cell.read("repo.tasks.list")).rows.map(({ taskId, snapshot }) => ({ taskId, status: snapshot.task?.status, pinned: snapshot.task?.pinned })).sort((left, right) => left.taskId.localeCompare(right.taskId)), [
      { taskId: "task_pinned", status: "cancelled", pinned: false },
      { taskId: "task_plain", status: "cancelled", pinned: false }
    ]);
  });
});

function pinnedAmendEvent(event: unknown): { readonly type: "task_amended"; readonly command: "amend"; readonly fields: readonly string[]; readonly pinned: boolean } {
  if (event === null || typeof event !== "object") throw new Error("expected a task event");
  const candidate = event as { readonly schema?: unknown; readonly type?: unknown; readonly payload?: { readonly mutation?: { readonly command?: unknown; readonly fields?: unknown }; readonly task?: { readonly pinned?: unknown } } };
  if (candidate.schema !== "task-event/v1" || candidate.type !== "task_amended" || candidate.payload?.mutation?.command !== "amend" || !Array.isArray(candidate.payload.mutation.fields) || typeof candidate.payload.task?.pinned !== "boolean") throw new Error("expected a pinned task_amended event");
  return { type: "task_amended", command: "amend", fields: candidate.payload.mutation.fields as readonly string[], pinned: candidate.payload.task.pinned };
}

async function withCell(name: string, run: (cell: Awaited<ReturnType<typeof openRepoCell>>, rootDir: string) => Promise<void>): Promise<void> { const rootDir = mkdtempSync(path.join(tmpdir(), `${name}-`)); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined; try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId(name), rootDir: canonicalRoot(rootDir), ownerId: name, now: () => "2026-08-21T12:00:00.000Z" }); await run(cell, rootDir); } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); } }
function decisionProposal() { return { kind: "decision-propose", jsonInput: JSON.stringify({ title: "Choose agenda behavior", question: "Should this proposal appear in the agenda?", riskTier: "medium", urgency: "high", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Project it" }], rejected: [{ id: "RJ1", text: "Hide it", whyNot: "It needs review" }], claims: [], fulfillments: [], relations: [] }) } as const; }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Agenda Test"); git(rootDir, "config", "user.email", "agenda@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
