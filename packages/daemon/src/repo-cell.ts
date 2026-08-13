import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTaskLifecycleService, type TaskLifecycleServiceProof } from "../../application/src/task-lifecycle-service.ts";
import { assertCurrentWriter, bindWriterGenerationToken, makeTaskEventStore, makeTaskProjection, normalizeCommandEnvelope,
  normalizeTaskLifecycleCommand, readRelationGraphProjection, type ActorIdentity, type CompleteTaskCommand, type EventPublicationKillpoint, type ProofFor,
  type TaskLifecycleCommand, VcsCommandError, type WriteReceipt, type WriteSource, type WriterGeneration } from "../../kernel/src/index.ts";
import { compileRepoTaskBootstrap, createPresetProcessService, presetUserRoot, runPresetAction, type PresetRunReceiptV1 } from "../../preset/src/index.ts";
import { commandClassForAction, type CanonicalRoot, type DaemonGuiReadMethod, type DaemonGuiReadResultMap, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import { bootstrapRepo, type RepoBootstrapInput } from "./repo-bootstrap.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { isDocAction, readDocReceipt, readProjectedDocument, runDocAction } from "./doc-sync-actions.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts"; import { makeAgentRuntimeStreamHub, type AgentRuntimeAttachSubscription, type AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { makeDecisionActions, makeFactActions } from "./fact-actions.ts";
import type { FleetAssignmentScope } from "./fleet/contract.ts";
export type RepoTaskAction = Readonly<Record<string, unknown>> & { readonly kind: string }; export interface RepoCellBinding { readonly actor: ActorIdentity; readonly source: WriteSource; readonly roles?: readonly string[]; readonly docWriteAllowed?: boolean; readonly assignmentScope?: FleetAssignmentScope }
export interface RepoCellStatus { readonly repoId: string; readonly rootDir: string; readonly state: "attached" | "unavailable" | "closed"; readonly generation: number; readonly queueDepth: number; readonly lastError: string | null; readonly recoveryMs: number }
export interface RepoCell { readonly run: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt>; readonly presetRun: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<PresetRunReceiptV1>; readonly read: <M extends DaemonGuiReadMethod>(method: M, payload?: Readonly<Record<string, unknown>>) => Promise<DaemonGuiReadResultMap[M]>; readonly attach: (runtimeSessionId: string, afterCursor: string) => Promise<AgentRuntimeAttachSubscription>; readonly runtime: Pick<AgentRuntimeStreamHub, "publish" | "issueWitnessToken" | "bindWitness">; readonly status: () => RepoCellStatus; readonly close: () => Promise<void> }
type DaemonGuiReadHandlers = { readonly [M in DaemonGuiReadMethod]: (payload: Readonly<Record<string, unknown>>) => DaemonGuiReadResultMap[M] };
const leaseTtlMs = 30 * 60 * 1_000; type Snapshot = Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["read"]>>["snapshot"];
export async function openRepoCell(input: { readonly repoId: WorkspaceId; readonly rootDir: CanonicalRoot; readonly ownerId: string;
  readonly bootstrap?: { readonly input: RepoBootstrapInput; readonly auth: DaemonAuthenticationContext };
  readonly now?: () => string; readonly killpoint?: (point: EventPublicationKillpoint) => void }): Promise<RepoCell> {
  const rootDir = input.rootDir, lock = await acquireWorkspaceLock(rootDir), generation = Date.now() * 1_000 + process.pid % 1_000;
  const activeWriter: WriterGeneration = { workspaceId: input.repoId, generation, ownerId: input.ownerId }, writerToken = bindWriterGenerationToken(activeWriter), now = input.now ?? (() => new Date().toISOString());
  try { if (input.bootstrap) bootstrapRepo(input.bootstrap.input, input.bootstrap.auth, activeWriter, writerToken); }
  catch (error) { await lock.close(); throw error; }
  const store = makeTaskEventStore({ repoId: input.repoId, rootDir, killpoint: input.killpoint }), recovery = store.recover(), projection = makeTaskProjection({ rootDir, eventStore: store, now });
  const factActions = makeFactActions({ store, projection, now, killpoint: input.killpoint }), decisionActions = makeDecisionActions({ store, projection, now, killpoint: input.killpoint });
  const runtimeStream = makeAgentRuntimeStreamHub({ readSession: (runtimeSessionId) => { projection.list(); return projection.readRuntimeSession(runtimeSessionId); }, canAttach: (session) => session.attachable && Boolean(projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach")), now: () => new Date(now()) }), runtimeReads = makeAgentRuntimeReadModel({ projection, store, stream: runtimeStream });
  const service = makeTaskLifecycleService({ eventStore: store, projection, killpoint: input.killpoint }); let state: RepoCellStatus["state"] = recovery.status === "indeterminate" || recovery.elapsedMs > 250 ? "unavailable" : "attached";
  let lastError: string | null = state === "attached" ? null : `startup recovery ${recovery.status} after ${recovery.elapsedMs.toFixed(3)}ms`;
  let queueDepth = 0, tail = Promise.resolve();
  const run = (action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> => {
    if (state !== "attached") return Promise.resolve(rejected(operationId(action, binding, input.repoId, 0), "repo_unavailable", lastError ?? "RepoCell is unavailable."));
    queueDepth += 1;
    const pending = tail.then(async () => { queueDepth -= 1; assertCurrentWriter(activeWriter, writerToken, input.repoId); return executeAction(action, binding); });
    tail = pending.then(() => undefined, () => undefined); const result = pending.catch((error) => { if (fatalCellError(error)) { state = "unavailable"; lastError = cellErrorMessage(error); }
      return failed(operationId(action, binding, input.repoId, 0), error); });
    return result;
  };
  const presetProcess = createPresetProcessService({ rootDir, userRoot: presetUserRoot(rootDir) }), presetRun: RepoCell["presetRun"] = async (action, binding) => action.kind === "preset-run-status" ? presetProcess.status(requiredString(action.runId, "runId")) : action.kind === "preset-run-start" ? presetProcess.start({ presetId: requiredString(action.presetId, "presetId"), entrypoint: requiredString(action.entrypoint, "entrypoint"), ...(typeof action.taskId === "string" ? { taskId: action.taskId } : {}), ...(action.inputs && typeof action.inputs === "object" && !Array.isArray(action.inputs) ? { inputs: action.inputs as Readonly<Record<string, unknown>> } : {}), idempotencyKey: requiredString(action.idempotencyKey, "idempotencyKey") }, { admitProduce: (kind) => { try { return commandClassForAction(kind) === "repo-write"; } catch { return false; } }, publish: (produced) => run(produced, binding) }) : { schema: "preset-run-receipt/v1", runId: "run_invalid", outcome: "rejected", phase: "rejected", phases: ["rejected"], code: "unsupported_command", nextAction: "Use repo.preset.run.start or repo.preset.run.status." };
  const readHandlers = { "repo.tasks.list": () => ({ ok: true, ...projection.list() }), "repo.triadic.relationGraph": () => { projection.readDecisionGraph(); const facts = projection.readFactGraph(), graph = readRelationGraphProjection({ rootDir }); return { ok: true as const, ...graph, facts: facts.facts }; },
    "repo.decisions.list": () => { const read = projection.searchDecisions({}); return { ok: true, decisions: read.decisions, warnings: [] }; }, "repo.tasks.document.read": (payload) => readProjectedDocument(projection, payload), "repo.agentRuntime.overview": runtimeReads.overview, "repo.agentRuntime.sessions.read": runtimeReads.session, "repo.agentRuntime.events.read": runtimeReads.events
  } satisfies DaemonGuiReadHandlers;
  const read: RepoCell["read"] = async (method, payload = {}) => { await tail; if (state !== "attached") throw cellCodedError("repo_unavailable", lastError ?? "RepoCell is unavailable."); return dispatchRead(readHandlers, method, payload); };
  return { run, presetRun, read, attach: async (runtimeSessionId, afterCursor) => { await tail; if (state !== "attached") throw cellCodedError("repo_unavailable", lastError ?? "RepoCell is unavailable."); return runtimeStream.attach(runtimeSessionId, afterCursor); }, runtime: runtimeStream,
    status: () => ({ repoId: input.repoId, rootDir, state, generation, queueDepth, lastError, recoveryMs: recovery.elapsedMs }),
    close: async () => { if (state === "closed") return; state = "closed"; runtimeStream.close(); await presetProcess.close(); await tail; await lock.close(); } };
  async function executeAction(action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> {
    if (action.kind === "receipt-show") return receiptForOperation(String(action.opId ?? ""), binding);
    if (action.kind === "task-show") return showTask(String(action.taskId ?? ""));
    if (action.kind.startsWith("fact-")) return factActions.run(action, binding, operationId(action, binding, input.repoId, store.readHead()?.revision ?? 0));
    if (action.kind.startsWith("decision-")) return decisionActions.run(action, binding, operationId(action, binding, input.repoId, store.readHead()?.revision ?? 0));
    if (action.kind.startsWith("preset-")) { const result = await runPresetAction({ rootDir, action }); return { outcome: "applied", opId: operationId(action, binding, input.repoId, store.readHead()?.revision ?? 0), revision: store.readHead()?.revision ?? 0, evidence: JSON.stringify(result), visibility: "center", proof: { committedRevision: store.readHead()?.revision ?? 0, appliedCut: projection.list().watermark, durable: true, canonicalVisible: true, worktreeVisible: action.kind === "preset-install" || action.kind === "preset-uninstall" } }; }
    if (action.kind === "task-create") return createTask(action, binding);
    if (isDocAction(action.kind)) return runDocAction({ action, binding, workspaceId: input.repoId, rootDir, store, projection, now, killpoint: input.killpoint });
    if (!taskWriteKind(action.kind)) return rejected(operationId(action, binding, input.repoId, 0), "unsupported_command", "No domain contract exists for this write command.");
    const taskId = requiredString(action.taskId, "taskId"), current = await service.read(taskId), expectedRevision = current.snapshot.revision;
    const normalized = buildCommand(action, taskId, binding, input.repoId, expectedRevision);
    const command = withServerMeta(normalized, store.readTaskEvent(normalized.opId), store.readHead()?.revision ?? 0, now());
    const result = await service.execute(command, await proofFor(command, current.snapshot, binding, action, rootDir));
    if (result.outcome === "applied") return { outcome: "applied", opId: command.opId, revision: result.revision, evidence: result.event ? `event-object:${result.event.opId}` : `task-revision:${result.revision}`, visibility: result.visibility, proof: result.proof };
    if (result.outcome === "pending") return { outcome: "pending", opId: command.opId, revision: result.revision, evidence: result.evidence, visibility: result.visibility, proof: result.proof, nextAction: result.nextAction ?? "Retry receipt show." };
    return rejected(command.opId, result.code ?? "publication_unknown", result.nextAction ?? "Retry receipt show before resubmitting.");
  }
  function createTask(action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt { const opId = operationId(action, binding, input.repoId, 0), existing = store.readEvent(opId); if (existing) { projection.list(); return receiptForOperation(opId, binding); } const taskId = createTaskId(action, binding, input.repoId); if (projection.read(taskId).snapshot.task) return rejected(opId, "task_exists", `Task ${taskId} already exists.`); const workspaceRevision = (store.readHead()?.revision ?? 0) + 1, eventId = `event-${createHash("sha256").update(opId).digest("hex")}`, compiled = compileRepoTaskBootstrap({ rootDir, action, taskId, actor: binding.actor, source: binding.source, workspaceRevision, eventId, opId, occurredAt: now() }), appended = store.append(compiled.event, compiled.plan, compiled.blobs); projection.apply(compiled.event, compiled.plan); input.killpoint?.("after_sqlite_commit"); const receipt: WriteReceipt = { outcome: "applied", opId, revision: appended.revision, evidence: `event-object:${opId}`, visibility: "center", proof: { committedRevision: appended.revision, appliedCut: appended.revision, durable: true, canonicalVisible: true, worktreeVisible: null } }; input.killpoint?.("before_response_write"); input.killpoint?.("after_response_write"); return receipt; }
  async function showTask(taskId: string): Promise<WriteReceipt> {
    const read = await service.read(requiredString(taskId, "taskId")), receipt = { opId: `read:${taskId}`, revision: read.sourceRevision, evidence: JSON.stringify(read.snapshot), visibility: "center" as const, proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark, durable: true, canonicalVisible: read.status === "ready", worktreeVisible: null } };
    return read.status === "ready" ? { outcome: "applied", ...receipt } : { outcome: "pending", ...receipt, nextAction: "Retry task show after projection catch-up." };
  }
  function receiptForOperation(opId: string, binding: RepoCellBinding): WriteReceipt {
    requiredString(opId, "opId"); const event = store.readEvent(opId);
    if (event === null) return rejected(opId, "operation_not_published", "No committed event exists; retry only if the original request was rejected.");
    if (event.schema === "doc-event/v1") return readDocReceipt({ binding, workspaceId: input.repoId, rootDir, store, projection, now, killpoint: input.killpoint }, event);
    const applied = projection.readOperation(opId), proof = { committedRevision: event.workspaceRevision, appliedCut: applied?.watermark ?? 0, durable: true, canonicalVisible: !!applied && applied.watermark >= event.workspaceRevision, worktreeVisible: null };
    return applied && applied.watermark >= event.workspaceRevision
      ? { outcome: "applied", opId, revision: event.workspaceRevision, evidence: `event-object:${opId}`, visibility: "center", proof }
      : { outcome: "pending", opId, revision: event.workspaceRevision, evidence: `event-object:${opId}`, visibility: "center", proof, nextAction: "Retry receipt show after projection catch-up." };
  }
} function dispatchRead<M extends DaemonGuiReadMethod>(handlers: DaemonGuiReadHandlers, method: M, payload: Readonly<Record<string, unknown>>): DaemonGuiReadResultMap[M] { return handlers[method](payload); }
function buildCommand(action: RepoTaskAction, taskId: string, binding: RepoCellBinding, workspaceId: string, expectedRevision: number): Omit<TaskLifecycleCommand, "eventId" | "workspaceRevision" | "occurredAt"> {
  const bound = { workspaceId, actor: binding.actor, source: binding.source, expectedRevision };
  if (action.kind === "task-start") return normalizeTaskLifecycleCommand(bound, { type: "StartExecution", taskId, executionId: requiredString(action.executionId, "executionId") });
  if (action.kind === "task-submit") return normalizeTaskLifecycleCommand(bound, { type: "SubmitExecution", taskId, executionId: requiredString(action.executionId, "executionId"), submission: { claim: requiredString(action.claim, "claim"),
    deliverables: strings(action.deliverables), evidenceRefs: strings(action.evidenceRefs), verification: strings(action.verification), knownGaps: strings(action.knownGaps), residualRisks: strings(action.residualRisks), commitSha: requiredString(action.commitSha, "commitSha") } });
  if (action.kind === "task-review-execution") return normalizeTaskLifecycleCommand(bound, { type: "RecordReview", taskId, executionId: requiredString(action.executionId, "executionId"), reviewId: requiredString(action.reviewId, "reviewId"), kind: reviewKind(action.reviewKind), verdict: reviewVerdict(action.verdict), actorRole: reviewKind(action.reviewKind), reason: requiredString(action.reason, "reason"), evidenceChecked: strings(action.evidenceChecked), commitSha: requiredString(action.commitSha, "commitSha"),
    iteration: iteration(action.iteration), archiveWarningsAcknowledged: action.archiveWarningsAcknowledged === true });
  if (action.kind === "task-complete") return normalizeTaskLifecycleCommand(bound, { type: "CompleteTask", taskId, executionId: requiredString(action.executionId, "executionId") });
  throw new Error(`unsupported lifecycle command ${action.kind}`);
}
function withServerMeta(command: Omit<TaskLifecycleCommand, "eventId" | "workspaceRevision" | "occurredAt">, existing: ReturnType<ReturnType<typeof makeTaskEventStore>["readTaskEvent"]>, revision: number, occurredAt: string): TaskLifecycleCommand {
  return { ...command, eventId: existing?.eventId ?? `event-${createHash("sha256").update(command.opId).digest("hex")}`, workspaceRevision: existing?.workspaceRevision ?? revision + 1, occurredAt: existing?.occurredAt ?? occurredAt } as TaskLifecycleCommand; }
async function proofFor(command: TaskLifecycleCommand, snapshot: Snapshot, binding: RepoCellBinding, action: RepoTaskAction,
  rootDir: string): Promise<TaskLifecycleServiceProof<typeof command>> {
  if (command.type === "CreateReplayTask") return { taskIdUnique: true, actorBinding: command.actor };
  if (command.type === "StartExecution") return { actorBinding: command.actor, reservation: { taskId: command.taskId, executionId: command.executionId, expiresAt: new Date(Date.parse(command.occurredAt) + leaseTtlMs).toISOString(), ttlMs: leaseTtlMs } };
  if (command.type === "SubmitExecution") { const lease = snapshot.lease; if (!lease || lease.phase !== "active" || lease.executionId !== command.executionId || !sameActor(lease.actor, command.actor)) throw cellCodedError("lease_required", "Submit requires the active execution lease bound to this actor.");
    return { actorBinding: command.actor, leaseVersion: lease.version, sessionDisposition: "unavailable" };
  }
  if (command.type === "RecordReview") { if (!binding.roles?.includes("$arbiter") || !independentReviewer(command.actor, snapshot)) throw cellCodedError("actor_unauthorized", `${command.kind} review requires an independent transport-bound arbiter.`);
    return { actorBinding: command.actor, capability: command.kind === "anti_entropy" ? "anti-entropy@v1" : "acceptance-review@v1",
      capabilityRef: `transport-reviewer:${command.actor.principal.personId}`, archiveWarningsPresent: false };
  }
  return completeProof(command, snapshot, action, rootDir) as TaskLifecycleServiceProof<typeof command>;
}
function completeProof(command: CompleteTaskCommand, snapshot: Snapshot, action: RepoTaskAction, rootDir: string): ProofFor<CompleteTaskCommand> {
  if (snapshot.lease !== null) throw cellCodedError("active_lease", "Complete requires the execution lease to be released.");
  if (snapshot.task?.createdBy.principal.personId !== command.actor.principal.personId) throw cellCodedError("actor_unauthorized", "Complete requires the Task owner.");
  const execution = snapshot.executions.find((candidate) => candidate.executionId === command.executionId && candidate.submission !== null);
  if (!execution?.submission) throw cellCodedError("invalid_transition", "Complete requires a submitted execution.");
  const supplied = gateReceipts(action.gateReceipts, snapshot.task?.completionGateIds ?? [], execution.executionId, execution.submission.commitSha, execution.iteration, rootDir);
  return { capability: "task-complete@v1", capabilityRef: `task-created-by:${command.taskId}:${command.actor.principal.personId}`, actorRole: "owner", noActiveLease: true, gateReceipts: supplied };
}
function createTaskId(action: RepoTaskAction, binding: RepoCellBinding, workspaceId: string): string { if (typeof action.taskId === "string" && action.taskId) return action.taskId;
  return `task_${operationId(action, binding, workspaceId, 0).slice(-26)}`; }
function operationId(action: RepoTaskAction, binding: RepoCellBinding, workspaceId: string, expectedRevision: number): string { const { actor: _actor, source: _source, root: _root, workspaceId: _workspace, serverWorkspaceId: _server, ...intent } = action;
  return normalizeCommandEnvelope({ workspaceId, actor: binding.actor, source: binding.source, expectedRevision, command: intent }).opId; }
function taskWriteKind(kind: string): boolean { return ["task-start", "task-submit", "task-review-execution", "task-complete"].includes(kind); }
function rejected(opId: string, code: string, nextAction: string): WriteReceipt { return { outcome: "rejected", opId, code, origin: "daemon", nextAction, evidence: `rejection:${code}` }; } function failed(opId: string, error: unknown): WriteReceipt { return error instanceof VcsCommandError ? { outcome: "indeterminate", opId, code: error.code, origin: error.origin, evidence: `git-failure:${error.command}`, nextAction: `repair the Git object store and retry: ${error.message}` } : rejected(opId, cellErrorCode(error), cellErrorMessage(error)); }
function requiredString(value: unknown, name: string): string { if (typeof value === "string" && value.trim()) return value; throw cellCodedError("invalid_command", `${name} is required.`); }
function strings(value: unknown): readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }
function sameActor(left: ActorIdentity, right: ActorIdentity): boolean { return left.principal.personId === right.principal.personId && left.executor?.id === right.executor?.id; }
function independentReviewer(actor: ActorIdentity, snapshot: Snapshot): boolean { const execution = snapshot.executions.find((candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null);
  return execution !== undefined && !sameActor(execution.actor, actor); }
function reviewKind(value: unknown): "anti_entropy" | "acceptance" { if (value === "anti_entropy" || value === "acceptance") return value;
  throw cellCodedError("invalid_command", "reviewKind must be anti_entropy or acceptance."); }
function reviewVerdict(value: unknown): "approved" | "changes_requested" | "dismissed" { if (value === "approved" || value === "changes_requested" || value === "dismissed") return value;
  throw cellCodedError("invalid_command", "verdict must be approved, changes_requested, or dismissed."); }
function iteration(value: unknown): number { if (value === 0 || value === 1) return value; throw cellCodedError("invalid_command", "iteration must be 0 or 1."); }
function gateReceipts(value: unknown, declared: readonly string[], executionId: string, commitSha: string, taskIteration: number, rootDir: string): ProofFor<CompleteTaskCommand>["gateReceipts"] {
  if (!Array.isArray(value)) throw cellCodedError("gate_receipt_mismatch", "gateReceipts must match every declared completion gate.");
  const receipts = value.map((entry) => { if (!entry || typeof entry !== "object") throw cellCodedError("gate_receipt_mismatch", "Gate receipt must be an object.");
    const gateId = requiredString((entry as { gateId?: unknown }).gateId, "gateId"), receiptRef = requiredString((entry as { receiptRef?: unknown }).receiptRef, "receiptRef"), candidate = path.resolve(rootDir, receiptRef.startsWith("file:") ? receiptRef.slice(5) : receiptRef);
    if (!(candidate === path.resolve(rootDir) || candidate.startsWith(`${path.resolve(rootDir)}${path.sep}`)) || !existsSync(candidate) || !statSync(candidate).isFile()) throw cellCodedError("gate_receipt_unverified", `Gate receipt ${receiptRef} must be an existing file in this workspace.`);
    return { gateId, receiptRef, result: "pass" as const, executionId, commitSha, iteration: taskIteration }; });
  if (receipts.length !== declared.length || declared.some((id) => receipts.filter((receipt) => receipt.gateId === id).length !== 1)) throw cellCodedError("gate_receipt_mismatch", "Supply exactly one verified receipt for each declared completion gate.");
  return receipts;
}
function cellCodedError(code: string, text: string): Error { const error = new Error(text) as Error & { code: string }; error.code = code; return error; }
function cellErrorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "service_rejected"; }
function cellErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fatalCellError(error: unknown): boolean { if (error instanceof VcsCommandError) return true; if (!(error instanceof Error) || !("code" in error)) return true; return ["invalid_store", "legacy_shape", "op_conflict", "revision_conflict", "publication_indeterminate", "writer_rejected"].includes(String(error.code)); }
async function acquireWorkspaceLock(rootDir: CanonicalRoot): Promise<{ readonly close: () => Promise<void> }> { const lockPath = `${rootDir}.harness-anything-writer.lock`; let descriptor: number;
  try { descriptor = openSync(lockPath, "wx", 0o600); writeFileSync(descriptor, `${process.pid}\n`, "utf8"); }
  catch (error) { throw cellCodedError("writer_rejected", `Workspace writer lock is held for ${rootDir}: ${cellErrorMessage(error)}`); }
  let closed = false; return { close: async () => { if (closed) return; closed = true; closeSync(descriptor); try { unlinkSync(lockPath); } catch (error) { if (cellErrorCode(error) === "ENOENT") { consumeKnownError(error); return; } throw error; } } }; }
const consumeKnownError = (error: unknown): void => { void error; };
