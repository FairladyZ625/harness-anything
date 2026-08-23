import { createHash } from "node:crypto";
import { closeoutReadiness, currentExecutionCuts, type ActorIdentity, type CloseoutSnapshot, type WriteReceipt } from "../../kernel/src/index.ts";

const submissionFields = ["completionClaim", "deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks", "commitSha"] as const;
const reviewFields = ["verdict", "reason", "evidenceChecked"] as const;
/** The `ci` completion gate id every CI judgment is reconciled against; the task contract owns whether it applies. */
const ciGateId = "ci";
const ciJudgments = ["passed", "not_applicable"] as const;
type CiJudgment = (typeof ciJudgments)[number];
type Judgment = {
  readonly submission: { readonly completionClaim: string; readonly deliverables: readonly string[]; readonly outputs: readonly string[]; readonly verificationNotes: readonly string[]; readonly knownGaps: readonly string[]; readonly residualRisks: readonly string[]; readonly commitSha: string };
  readonly review: { readonly verdict: "approved" | "changes_requested" | "dismissed"; readonly reason: string; readonly evidenceChecked: readonly string[] };
  readonly consent: { readonly approved: true };
  readonly completion: { readonly ci: CiJudgment; readonly codeDocPaths: readonly string[] };
};
type Snapshot = CloseoutSnapshot & {
  readonly task: (NonNullable<CloseoutSnapshot["task"]> & { readonly taskId: string; readonly currentNode: string; readonly createdBy: ActorIdentity }) | null;
  readonly lease: { readonly executionId: string; readonly actor: ActorIdentity } | null;
};
export type CloseoutStep = "submit" | "review-execution" | "review-consent" | "complete" | "task-show";
export interface TaskCloseoutActionDependencies {
  readonly rootDir: string;
  readonly action: Readonly<Record<string, unknown>>;
  readonly caller: ActorIdentity;
  readonly opId: string;
  readonly readWorkspaceText: (rootDir: string, requested: string, field: string) => string;
  readonly read: () => Promise<Snapshot>;
  readonly invoke: (stage: CloseoutStep, action: Readonly<Record<string, unknown>>, actor: ActorIdentity) => Promise<WriteReceipt>;
}

/** One compound daemon action; every mutation still runs through the canonical leaf lifecycle commands. */
export async function runTaskCloseoutAction(dependencies: TaskCloseoutActionDependencies): Promise<WriteReceipt> {
  const { action, caller, opId } = dependencies, taskId = requiredText(action.taskId, "taskId"), fromFile = requiredText(action.fromFile, "fromFile"), executionId = typeof action.executionId === "string" ? action.executionId : undefined, invocation = closeoutInvocation(taskId, fromFile, executionId);
  let judgment: Judgment;
  try { judgment = readJudgment(() => dependencies.readWorkspaceText(dependencies.rootDir, fromFile, "fromFile")); }
  catch (error) { return reject(opId, "invalid_judgment", `${error instanceof Error ? error.message : String(error)} Repair the packet, then run ${invocation}.`); }
  const snapshot = await dependencies.read(), task = snapshot.task;
  if (!task || task.taskId !== taskId) return reject(opId, "task_not_found", `Run ha task list, choose an existing task id, then run ${invocation}.`);
  if (task.status === "done") { const shown = await dependencies.invoke("task-show", { kind: "task-show", taskId }, caller); return { ...shown, taskId, summary: `task ${taskId} is already done`, steps: [] } as WriteReceipt; }
  if (task.status === "planned") return reject(opId, "not_started", `Run ha task start ${taskId} --execution-id <execution-id>, then run ${invocation}.`);
  if (task.status === "blocked") return reject(opId, "task_blocked", `Run ha task transition ${taskId} active, then run ${invocation}.`);
  if (task.status === "cancelled") return reject(opId, "terminal_task", `Run ha task supersede ${taskId} --title <follow-up-title> to create new work; the cancelled task cannot be closed out.`);
  if (task.status !== "active" && task.status !== "in_review") return reject(opId, "invalid_transition", `Run ha task show ${taskId}, repair its lifecycle state, then run ${invocation}.`);
  const ciIssue = ciJudgmentIssue(task.completionGateIds, judgment.completion.ci);
  if (ciIssue) return reject(opId, "invalid_judgment", `${ciIssue} Repair the packet, then run ${invocation}.`);
  if (task.createdBy.principal.personId !== caller.principal.personId) return reject(opId, "actor_unauthorized", `The Task owner (${task.createdBy.principal.personId}) must run ${invocation}.`);

  const reviewId = deterministicId("review-closeout", taskId, String(task.iteration), judgment.submission.commitSha, judgment.review), consentId = deterministicId("consent-closeout", taskId, String(task.iteration), judgment.submission.commitSha, reviewId);
  let stage = 0, submitActor: ActorIdentity | null = null;
  if (task.status === "active") {
    if (!snapshot.lease) return reject(opId, "lease_required", `Run ha task start ${taskId} --execution-id <execution-id>, then run ${invocation}.`);
    if (executionId && snapshot.lease.executionId !== executionId) return candidateRejection(opId, taskId, fromFile, [snapshot.lease.executionId]);
    const active = snapshot.executions.find((candidate) => candidate.executionId === snapshot.lease?.executionId && candidate.iteration === task.iteration && candidate.state === "active" && candidate.submission === null);
    if (!active) return reject(opId, "invalid_transition", `Run ha task show ${taskId}, restore one active leased execution, then run ${invocation}.`);
    if (snapshot.lease.actor.principal.personId !== caller.principal.personId) return reject(opId, "actor_unauthorized", `The active lease holder must run ${invocation}.`);
    submitActor = snapshot.lease.actor;
  } else {
    const cuts = currentExecutionCuts(snapshot), candidates = executionId ? cuts.filter((candidate) => candidate.executionId === executionId) : cuts;
    if (candidates.length !== 1) return candidateRejection(opId, taskId, fromFile, cuts.map((candidate) => candidate.executionId));
    const selected = candidates[0]!;
    if (!sameFields(selected.submission, judgment.submission, submissionFields)) return reject(opId, "submission_mismatch", `Run ha task show ${taskId}, make ${fromFile} submission match execution ${selected.executionId}, then run ${invocation}.`);
    const assessed = closeoutReadiness(executionId ? { ...snapshot, executions: snapshot.executions.filter((candidate) => candidate.iteration !== task.iteration || candidate.executionId === executionId) } : snapshot);
    if (assessed.blocker === "projection_unknown") return reject(opId, "projection_unknown", `Run ha task show ${taskId}, wait for a complete projection, then run ${invocation}.`);
    stage = assessed.blocker === "review" ? 1 : assessed.blocker === "consent" ? 2 : 3;
    if (stage > 1 && !snapshot.reviews.some((review) => review.executionId === selected.executionId && review.reviewId === reviewId)) stage = 1;
    if (stage > 2 && !snapshot.consents.some((consent) => consent.executionId === selected.executionId && consent.reviewId === reviewId)) stage = 2;
  }

  const selector = executionId ? { executionId } : {}, humanReviewer: ActorIdentity = { principal: caller.principal, executor: null }, steps: Array<WriteReceipt & { readonly stage: string }> = [];
  if (stage <= 0) { const stopped = await invoke("submit", { kind: "task-submit", taskId, ...selector, submission: judgment.submission }, submitActor ?? caller); if (stopped) return stopped; }
  if (stage <= 1) { const reviewBody = `${JSON.stringify(judgment.review, null, 2)}\n`, stopped = await invoke("review-execution", { kind: "task-review-execution", taskId, ...selector, reviewId, jsonInput: reviewBody }, humanReviewer); if (stopped) return stopped;
    if (judgment.review.verdict !== "approved") return { ...reject(opId, judgment.review.verdict === "changes_requested" ? "changes_requested" : "review_not_approved", judgment.review.verdict === "changes_requested" ? `Run ha task start ${taskId} --execution-id <execution-id>, address the requested changes, then run ${invocation} with the next judgment.` : `Have an independent arbiter record an approved judgment, then run ${invocation}.`), stoppedAt: "review-execution", steps } as WriteReceipt; }
  if (stage <= 2) { const stopped = await invoke("review-consent", { kind: "task-review-consent", taskId, ...selector, reviewId, consentId }, task.createdBy); if (stopped) return stopped; }
  const ciFlag = judgment.completion.ci === "passed" ? { ci: "passed" as const } : {};
  const pathFlag = judgment.completion.codeDocPaths.length ? { paths: judgment.completion.codeDocPaths } : {};
  const completion = { kind: "task-complete", taskId, ...selector, ...ciFlag, ...pathFlag };
  const stopped = await invoke("complete", completion, task.createdBy);
  if (stopped) return stopped;
  const { stage: _stage, ...final } = steps.at(-1)!;
  return { ...final, taskId, reviewId, consentId, submittedCommitSha: judgment.submission.commitSha, summary: `closed out task ${taskId}`, steps } as WriteReceipt;

  async function invoke(name: Exclude<CloseoutStep, "task-show">, leaf: Readonly<Record<string, unknown>>, actor: ActorIdentity): Promise<WriteReceipt | null> {
    const receipt = await dependencies.invoke(name, leaf, actor); steps.push({ stage: name, ...receipt });
    if (receipt.outcome === "applied") return null;
    const row = receipt as WriteReceipt & { readonly next?: readonly { readonly command?: string }[] }, candidate = receipt.nextAction ?? row.next?.[0]?.command ?? "", fallback = name === "submit" ? `The active lease holder must run ${invocation}.` : name === "review-execution" ? `Have an independent arbiter run ${invocation}.` : name === "review-consent" ? `The Task owner must run ${invocation}.` : `Run ha task complete ${taskId} to inspect the blocking gate, then retry ${invocation}.`, nextAction = /\bha\s/u.test(candidate) ? candidate : fallback;
    return { ...receipt, code: receipt.code ?? "closeout_stopped", nextAction, stoppedAt: name, steps } as WriteReceipt;
  }
}

function readJudgment(readText: () => string): Judgment { let parsed: unknown; try { parsed = JSON.parse(readText()); } catch (error) { throw new Error(`Closeout judgment must be one readable JSON object inside the workspace: ${error instanceof Error ? error.message : String(error)}`); } return validateJudgment(parsed); }
function validateJudgment(value: unknown): Judgment { const packet = exact(value, ["submission", "review", "consent", "completion"], "judgment packet"), submission = exact(packet.submission, submissionFields, "submission"), review = exact(packet.review, reviewFields, "review"), consent = exact(packet.consent, ["approved"], "consent"), completion = exact(packet.completion, ["ci", "codeDocPaths"], "completion"); requiredText(submission.completionClaim, "submission.completionClaim"); for (const field of ["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const) stringList(submission[field], `submission.${field}`); if (!/^[0-9a-f]{40}$/u.test(String(submission.commitSha))) throw new Error("submission.commitSha must be a full 40-character Git SHA."); if (!["approved", "changes_requested", "dismissed"].includes(String(review.verdict))) throw new Error("review.verdict must be approved, changes_requested, or dismissed."); requiredText(review.reason, "review.reason"); stringList(review.evidenceChecked, "review.evidenceChecked"); if (consent.approved !== true) throw new Error("consent.approved must be true; closeout never invents consent intent."); ciJudgmentToken(completion.ci); stringList(completion.codeDocPaths, "completion.codeDocPaths"); return { submission, review, consent, completion } as unknown as Judgment; }
function exact(value: unknown, fields: readonly string[], name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new Error(`${name} requires exactly: ${fields.join(", ")}.`); return value as Record<string, unknown>; }
/**
 * The task contract, never the executor, decides which CI judgment is honest for this task.
 * A declared `ci` completion gate demands `passed`; no declared `ci` gate demands `not_applicable`,
 * because there is no CI run on this change for `passed` to refer to. Exactly one value is legal
 * either way, so closeout can neither invent a green CI run nor wave away a gate the contract declared.
 */
function ciJudgmentIssue(completionGateIds: readonly string[], ci: CiJudgment): string | null {
  const declared = completionGateIds.includes(ciGateId);
  if (ci === (declared ? "passed" : "not_applicable")) return null;
  const because = declared
    ? `declares the ${ciGateId} completion gate`
    : `declares no ${ciGateId} completion gate, so no CI run judges this change`;
  const expected = declared ? "passed" : "not_applicable";
  return `completion.ci must be ${expected} because this task contract ${because};`
    + " closeout never invents a CI judgment.";
}
/** Packet-shape check only: the token set is closed here, and which token is honest is the contract's call below. */
function ciJudgmentToken(value: unknown): CiJudgment {
  if (ciJudgments.includes(value as CiJudgment)) return value as CiJudgment;
  throw new Error(`completion.ci must be ${ciJudgments.join(" or ")}; closeout never invents a CI judgment.`);
}
function requiredText(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; }
function stringList(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${name} must be an array of non-empty strings.`); return value; }
function deterministicId(prefix: string, ...parts: readonly unknown[]): string { return `${prefix}-${createHash("sha256").update(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("\0")).digest("hex").slice(0, 16)}`; }
function closeoutInvocation(taskId: string, fromFile: string, executionId?: string): string { return `ha task closeout ${taskId} --from-file ${fromFile}${executionId ? ` --execution-id ${executionId}` : ""}`; }
function candidateRejection(opId: string, taskId: string, fromFile: string, candidates: readonly string[]): WriteReceipt { const commands = candidates.map((candidate) => closeoutInvocation(taskId, fromFile, candidate)); return reject(opId, "ambiguous_execution", `Current submitted execution candidates: ${candidates.length ? candidates.join(", ") : "none"}. ${commands.length ? `Choose one explicitly: ${commands.join(" or ")}.` : `Run ha task submit ${taskId} --from-file <submission.json>, then run ${closeoutInvocation(taskId, fromFile)}.`}`); }
function reject(opId: string, code: string, nextAction: string): WriteReceipt { return { outcome: "op_rejected", opId, code, origin: "daemon", evidence: `rejection:${code}`, nextAction }; }
function sameFields(left: unknown, right: unknown, fields: readonly string[]): boolean { if (!left || typeof left !== "object" || !right || typeof right !== "object") return false; const select = (value: object) => Object.fromEntries(fields.map((field) => [field, (value as Record<string, unknown>)[field]])); return JSON.stringify(select(left)) === JSON.stringify(select(right)); }
