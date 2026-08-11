import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createWriteReceipt, normalizeCommandEnvelope, normalizeTaskLifecycleCommand, REPLAY_TASK_GRAPH, TASK_LIFECYCLE_COMMAND_CATALOG } from "../../../../kernel/src/index.ts";
import type {
  ActorAxes,
  CompleteTaskCommand,
  CreateReplayTaskCommand,
  RecordReviewCommand,
  StartExecutionCommand,
  SubmitExecutionCommand,
  TaskLifecycleCommandType,
  WriteReceipt
} from "../../../../kernel/src/index.ts";
import type { TaskLifecycleCliAction } from "../../cli/types.ts";
export type { TaskLifecycleCliAction } from "../../cli/types.ts";

type ClientMeta = "eventId" | "workspaceRevision" | "occurredAt";
type ClientCommand =
  | Omit<CreateReplayTaskCommand, ClientMeta> | Omit<StartExecutionCommand, ClientMeta>
  | Omit<SubmitExecutionCommand, ClientMeta> | Omit<RecordReviewCommand, ClientMeta> | Omit<CompleteTaskCommand, ClientMeta>;

export type TaskLifecycleReceipt = WriteReceipt;

const verifiedReceiptBrand: unique symbol = Symbol("verified-anti-entropy-receipt");
export interface VerifiedReceipt { readonly digest: string; readonly [verifiedReceiptBrand]: true }

export interface TaskLifecycleServiceInput {
  readonly command: ClientCommand;
  readonly verifiedReceipt?: VerifiedReceipt;
  readonly gateReceipts?: readonly { readonly gateId: string; readonly receiptRef: string }[];
}

export interface TaskLifecycleServicePort {
  readonly execute: (input: TaskLifecycleServiceInput) => Promise<TaskLifecycleReceipt>;
  readonly show: (input: { readonly taskId: string }) => Promise<TaskLifecycleReceipt>;
}

type ShowAction = Extract<TaskLifecycleCliAction, { readonly verb: "show" }>;
type AntiEntropyReviewAction = Extract<TaskLifecycleCliAction, { readonly antiEntropyToken: string }>;
type ReviewAction = Extract<TaskLifecycleCliAction, { readonly verb: "review-execution" }>;
type SubmitAction = Extract<TaskLifecycleCliAction, { readonly verb: "submit" }>;
type CompleteAction = Extract<TaskLifecycleCliAction, { readonly verb: "complete" }>;

export type TaskLifecycleParseResult =
  | { readonly ok: true; readonly value: TaskLifecycleCliAction }
  | { readonly ok: false; readonly error: { readonly code: string; readonly origin: "cli"; readonly nextAction: string } };

function cliVerb(commandType: TaskLifecycleCommandType): Exclude<TaskLifecycleCliAction["verb"], "show"> {
  if (commandType === "RecordReview") return "review-execution";
  return commandType.replace(/(ReplayTask|Execution|Task)$/u, "").replace(/^Record/u, "").toLowerCase() as Exclude<TaskLifecycleCliAction["verb"], "show">;
}

export const TASK_LIFECYCLE_CLI_COMMANDS = Object.freeze(
  [...new Set(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => entry.commandType))]
    .map((commandType) => Object.freeze({ commandType, verb: cliVerb(commandType) }))
);

const writeCommandByVerb = new Map<string, TaskLifecycleCommandType>(TASK_LIFECYCLE_CLI_COMMANDS.map((entry) => [entry.verb, entry.commandType]));
const helpByVerb = Object.freeze({
  start: "Usage: ha task start <task-id> --execution-id <execution-id>",
  submit: "Usage: ha task submit <task-id> --execution-id <execution-id> --claim <text> --commit-sha <40-sha> [--deliverable <text>]... [--evidence-ref <ref>]... [--verification <text>]... [--known-gap <text>]... [--residual-risk <text>]...",
  "review-execution": "Usage: ha task review-execution <task-id> --execution-id <execution-id> (--anti-entropy-token <token> --anti-entropy-report <path> | --kind acceptance --verdict approved|dismissed --review-id <id> --reason <text> --commit-sha <40-sha> --iteration 0|1)",
  complete: "Usage: ha task complete <task-id> --execution-id <submitted-execution-id> [--gate-receipt <gate-id>:<receipt-ref>]..."
});
export function renderTaskLifecycleHelp(verb: keyof typeof helpByVerb): string {
  if (!writeCommandByVerb.has(verb)) throw new Error(`Lifecycle command ${verb} is absent from TASK_LIFECYCLE_COMMAND_CATALOG.`);
  return helpByVerb[verb];
}

export function parseTaskLifecycleArgs(args: readonly string[]): TaskLifecycleParseResult {
  if (args[0] !== "task") return rejected("invalid_command", "Start with `ha task <command>`." );
  const verb = args[1];
  if (verb === "show") {
    return args.length === 3 && nonEmpty(args[2])
      ? { ok: true, value: { kind: "task-show", verb, taskId: args[2] } }
      : rejected("invalid_command", "Run `ha task show <task-id>`." );
  }
  const commandType = writeCommandByVerb.get(verb ?? "");
  if (commandType === undefined) return rejected("invalid_command", "Run `ha task --help` and choose create, start, submit, review-execution, complete, or show." );
  if (verb === "create") {
    const parsed = flags(args.slice(2), new Set(["--title", "--task-id"]), new Set(["--completion-gate"]));
    if (!parsed.ok) return parsed;
    const title = parsed.single.get("--title");
    if (!nonEmpty(title)) return rejected("missing_field", "Add `--title <title>` to create a replay/v1 task." );
    const taskId = parsed.single.get("--task-id");
    return { ok: true, value: {
      kind: "task-create",
      verb,
      commandType: commandType as "CreateReplayTask",
      ...(taskId ? { taskId } : {}),
      title,
      completionGateIds: parsed.repeated.get("--completion-gate") ?? []
    } };
  }
  const taskId = args[2];
  if (!nonEmpty(taskId)) return rejected("missing_field", `Run \`ha task ${verb} <task-id> ...\`.` );
  if (verb === "start") {
    const parsed = flags(args.slice(3), new Set(["--execution-id"]));
    if (!parsed.ok) return parsed;
    const executionId = parsed.single.get("--execution-id");
    if (!nonEmpty(executionId)) return rejected("missing_field", "Add `--execution-id <execution-id>`; start creates exactly that Execution." );
    return { ok: true, value: { kind: "task-start", verb, commandType: commandType as "StartExecution", taskId, executionId } };
  }
  if (verb === "submit") {
    const parsed = flags(
      args.slice(3),
      new Set(["--execution-id", "--claim", "--commit-sha"]),
      new Set(["--deliverable", "--evidence-ref", "--verification", "--known-gap", "--residual-risk"])
    );
    if (!parsed.ok) return parsed;
    const executionId = parsed.single.get("--execution-id");
    const claim = parsed.single.get("--claim");
    const commitSha = parsed.single.get("--commit-sha");
    if (!nonEmpty(executionId)) return rejected("missing_field", "Add `--execution-id <value>`; run `ha task submit --help`." );
    if (!nonEmpty(claim)) return rejected("missing_field", "Add `--claim <value>`; run `ha task submit --help`." );
    if (!nonEmpty(commitSha)) return rejected("missing_field", "Add `--commit-sha <value>`; run `ha task submit --help`." );
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) return rejected("invalid_field", "Use `--commit-sha` with the full lowercase 40-character code commit SHA." );
    return { ok: true, value: {
      kind: "task-submit",
      verb,
      commandType: commandType as "SubmitExecution",
      taskId,
      executionId,
      claim,
      deliverables: parsed.repeated.get("--deliverable") ?? [],
      evidenceRefs: parsed.repeated.get("--evidence-ref") ?? [],
      verification: parsed.repeated.get("--verification") ?? [],
      knownGaps: parsed.repeated.get("--known-gap") ?? [],
      residualRisks: parsed.repeated.get("--residual-risk") ?? [],
      commitSha
    } };
  }
  if (verb === "review-execution") {
    const antiEntropy = args.includes("--anti-entropy-token") || args.includes("--anti-entropy-report");
    const parsed = antiEntropy
      ? flags(args.slice(3), new Set(["--execution-id", "--anti-entropy-token", "--anti-entropy-report"]))
      : flags(
          args.slice(3),
          new Set(["--execution-id", "--kind", "--verdict", "--review-id", "--reason", "--commit-sha", "--iteration"]),
          new Set(["--evidence-checked"]),
          new Set(["--acknowledge-archive-warnings"])
        );
    if (!parsed.ok) return parsed;
    const executionId = parsed.single.get("--execution-id");
    if (!antiEntropy) {
      const kind = parsed.single.get("--kind");
      const verdict = parsed.single.get("--verdict");
      const reviewId = parsed.single.get("--review-id");
      const reason = parsed.single.get("--reason");
      const commitSha = parsed.single.get("--commit-sha");
      const iteration = Number(parsed.single.get("--iteration"));
      if (verdict === "changes_requested") return rejected("invalid_transition", "Only anti-entropy can request changes; supply the frozen report with `--anti-entropy-token` and `--anti-entropy-report`." );
      if (!nonEmpty(executionId) || !nonEmpty(kind) || !nonEmpty(verdict) || !nonEmpty(reviewId) || !nonEmpty(reason) || !nonEmpty(commitSha) || !nonEmpty(parsed.single.get("--iteration"))) {
        return rejected("missing_field", "Acceptance review requires --execution-id, --kind, --verdict, --review-id, --reason, --commit-sha, and --iteration; run `ha task review-execution --help`." );
      }
      if (kind !== "acceptance") return rejected("invalid_field", "Use `--kind acceptance`, or use the signed anti-entropy report path." );
      if (verdict !== "approved" && verdict !== "dismissed") return rejected("invalid_field", "Acceptance verdict must be approved or dismissed; changes_requested belongs to signed anti-entropy review." );
      if (!/^[0-9a-f]{40}$/u.test(commitSha)) return rejected("invalid_field", "Use `--commit-sha` with the full lowercase 40-character submitted commit SHA." );
      if (iteration !== 0 && iteration !== 1) return rejected("invalid_field", "Use `--iteration 0` or `--iteration 1` for the current Task round." );
      return { ok: true, value: {
        kind: "task-review-execution",
        verb,
        commandType: commandType as "RecordReview",
        taskId,
        executionId,
        reviewId,
        reviewKind: kind,
        verdict,
        reason,
        evidenceChecked: parsed.repeated.get("--evidence-checked") ?? [],
        commitSha,
        iteration,
        archiveWarningsAcknowledged: parsed.booleans.has("--acknowledge-archive-warnings")
      } };
    }
    const antiEntropyToken = parsed.single.get("--anti-entropy-token");
    const antiEntropyReport = parsed.single.get("--anti-entropy-report");
    if (!nonEmpty(executionId) || !nonEmpty(antiEntropyToken) || !nonEmpty(antiEntropyReport)) {
      return rejected("missing_field", "Anti-entropy review requires --execution-id, --anti-entropy-token, and --anti-entropy-report; run `ha task review-execution --help`." );
    }
    return { ok: true, value: {
      kind: "task-review-execution",
      verb,
      commandType: commandType as "RecordReview",
      taskId,
      executionId,
      antiEntropyToken,
      antiEntropyReport
    } };
  }
  if (verb === "complete") {
    const parsed = flags(args.slice(3), new Set(["--execution-id"]), new Set(["--gate-receipt"]));
    if (!parsed.ok) return parsed;
    const executionId = parsed.single.get("--execution-id");
    if (!nonEmpty(executionId)) return rejected("missing_field", "Add `--execution-id <submitted-execution-id>`; complete never guesses a round." );
    const gateReceipts: { gateId: string; receiptRef: string }[] = [];
    for (const raw of parsed.repeated.get("--gate-receipt") ?? []) {
      const separator = raw.indexOf(":");
      const gateId = raw.slice(0, separator).trim();
      const receiptRef = raw.slice(separator + 1).trim();
      if (separator <= 0 || !nonEmpty(gateId) || !nonEmpty(receiptRef)) return rejected("invalid_field", "Use `--gate-receipt <gate-id>:<receipt-ref>` with both values present." );
      gateReceipts.push({ gateId, receiptRef });
    }
    return { ok: true, value: { kind: "task-complete", verb, commandType: commandType as "CompleteTask", taskId, executionId, gateReceipts } };
  }
  return { ok: true, value: { kind: `task-${verb}`, verb, commandType, taskId } as SubmitAction | ReviewAction | CompleteAction };
}

export interface TaskLifecycleFacadeDependencies {
  readonly actor: ActorAxes;
  readonly workspaceId: string;
  readonly service: TaskLifecycleServicePort;
  readonly readReport?: (path: string) => Promise<string>;
  readonly verifyReceipt?: (input: { readonly token: string; readonly scope: string; readonly verdict: "approved" | "rejected"; readonly headSha: string; readonly now: Date; readonly environment: NodeJS.ProcessEnv }) => Promise<{ readonly ok: boolean; readonly errors: readonly string[] }>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export async function runTaskLifecycleFacade(action: TaskLifecycleCliAction, dependencies: TaskLifecycleFacadeDependencies): Promise<TaskLifecycleReceipt> {
  if (action.verb === "show") return validateReceipt(await dependencies.service.show({ taskId: action.taskId }));
  let opId = operationId(action, dependencies.actor, dependencies.workspaceId, 0);
  try {
    const expectedRevision = action.verb === "create" ? 0 : (await dependencies.service.show({ taskId: action.taskId })).revision ?? 0;
    const input = await buildServiceInput(action, dependencies, opId, expectedRevision);
    opId = input.command.opId;
    return validateReceipt(await dependencies.service.execute(input));
  } catch (error) {
    return validateReceipt({
      outcome: "rejected",
      opId,
      code: errorCode(error), evidence: `cli-rejection:${errorCode(error)}`,
      origin: errorOrigin(error),
      nextAction: errorOrigin(error) !== "task-lifecycle-cli" && error instanceof Error ? error.message : `Run \`ha task show ${action.taskId}\` before retrying. Details: ${error instanceof Error ? error.message : "unclassified service rejection"}`
    });
  }
}

async function buildServiceInput(action: Exclude<TaskLifecycleCliAction, ShowAction>, dependencies: TaskLifecycleFacadeDependencies, opId: string, expectedRevision: number): Promise<TaskLifecycleServiceInput> {
  const actor = dependencies.actor;
  const binding = { workspaceId: dependencies.workspaceId, actor, source: "local" as const, expectedRevision };
  if (action.verb === "create") {
    return { command: normalizeTaskLifecycleCommand(binding, {
      type: action.commandType,
      taskId: action.taskId ?? `task_${opId.slice(-26)}`,
      title: action.title,
      graph: REPLAY_TASK_GRAPH,
      completionGateIds: action.completionGateIds
    }) };
  }
  if (action.verb === "start") {
    return { command: normalizeTaskLifecycleCommand(binding,
      { type: action.commandType, taskId: action.taskId, executionId: action.executionId }) };
  }
  if (action.verb === "submit") {
    return {
      command: normalizeTaskLifecycleCommand(binding, {
        type: action.commandType,
        taskId: action.taskId,
        executionId: action.executionId,
        submission: {
          claim: action.claim,
          deliverables: action.deliverables,
          evidenceRefs: action.evidenceRefs,
          verification: action.verification,
          knownGaps: action.knownGaps,
          residualRisks: action.residualRisks,
          commitSha: action.commitSha
        }
      })
    };
  }
  if (action.verb === "review-execution") {
    if ("antiEntropyToken" in action) return antiEntropyReviewInput(action, dependencies, expectedRevision);
    return { command: normalizeTaskLifecycleCommand(binding, {
      type: action.commandType,
      taskId: action.taskId,
      executionId: action.executionId,
      reviewId: action.reviewId,
      kind: action.reviewKind,
      verdict: action.verdict,
      actorRole: "acceptance",
      reason: action.reason,
      evidenceChecked: action.evidenceChecked,
      commitSha: action.commitSha,
      iteration: action.iteration,
      archiveWarningsAcknowledged: action.archiveWarningsAcknowledged
    }) };
  }
  if (action.verb === "complete") {
    return {
      command: normalizeTaskLifecycleCommand(binding,
        { type: action.commandType, taskId: action.taskId, executionId: action.executionId }),
      gateReceipts: action.gateReceipts
    };
  }
  throw Object.assign(new Error("Lifecycle input is incomplete; run the command with --help."), { code: "invalid_command" });
}

function operationId(action: TaskLifecycleCliAction, actor: ActorAxes, workspaceId: string, expectedRevision: number): string {
  const intent = action.verb === "review-execution" && "antiEntropyToken" in action ? { ...action, antiEntropyToken: undefined, antiEntropyReport: undefined }
    : action;
  return normalizeCommandEnvelope({ workspaceId, actor, source: "local", expectedRevision,
    command: intent as unknown as Readonly<Record<string, unknown>> }).opId;
}

function flags(tokens: readonly string[], singleAllowed: ReadonlySet<string>, repeatedAllowed: ReadonlySet<string> = new Set(), booleanAllowed: ReadonlySet<string> = new Set()):
  | { readonly ok: true; readonly single: Map<string, string>; readonly repeated: Map<string, string[]>; readonly booleans: Set<string> }
  | Extract<TaskLifecycleParseResult, { readonly ok: false }> {
  const single = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index];
    if (!name?.startsWith("--") || (!singleAllowed.has(name) && !repeatedAllowed.has(name) && !booleanAllowed.has(name))) return rejected("unknown_field", `Unknown option ${name ?? "<missing>"}; run the command with --help.` );
    if (booleanAllowed.has(name)) {
      if (booleans.has(name)) return rejected("duplicate_field", `${name} may be supplied only once.` );
      booleans.add(name);
      continue;
    }
    const value = tokens[index += 1];
    if (!nonEmpty(value) || value.startsWith("--")) return rejected("missing_field", `${name} requires a value; run the command with --help.` );
    if (singleAllowed.has(name)) {
      if (single.has(name)) return rejected("duplicate_field", `${name} may be supplied only once.` );
      single.set(name, value);
    } else repeated.set(name, [...repeated.get(name) ?? [], value]);
  }
  return { ok: true, single, repeated, booleans };
}

function rejected(code: string, nextAction: string): Extract<TaskLifecycleParseResult, { readonly ok: false }> {
  return { ok: false, error: { code, origin: "cli", nextAction } };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "service_rejected";
}

function errorOrigin(error: unknown): string {
  return typeof error === "object" && error !== null && "origin" in error && typeof error.origin === "string" ? error.origin : "task-lifecycle-cli";
}

function validateReceipt(receipt: TaskLifecycleReceipt): TaskLifecycleReceipt {
  return createWriteReceipt(receipt);
}

export const readAntiEntropyReport = (path: string): Promise<string> => readFile(path, "utf8");

interface FrozenAntiEntropyReport {
  readonly scope: string;
  readonly headSha: string;
  readonly iteration: 0 | 1;
  readonly reviewerSession: string;
  readonly snapshotDigest: string;
  readonly verdict: "approved" | "rejected";
  readonly reason: string;
  readonly digest: string;
}

async function antiEntropyReviewInput(action: AntiEntropyReviewAction, dependencies: TaskLifecycleFacadeDependencies, expectedRevision: number): Promise<TaskLifecycleServiceInput> {
  const body = await (dependencies.readReport ?? readAntiEntropyReport)(action.antiEntropyReport);
  const report = parseAntiEntropyReport(body);
  if (dependencies.verifyReceipt === undefined) throw Object.assign(new Error("Configure the receipt-verify adapter, then retry the signed frozen report."), { code: "receipt_verifier_unavailable", origin: "receipt-verify" });
  const verification = await dependencies.verifyReceipt({
    token: action.antiEntropyToken,
    now: dependencies.now ?? new Date(),
    environment: dependencies.environment ?? process.env,
    scope: report.scope,
    verdict: report.verdict,
    headSha: report.headSha
  });
  if (!verification.ok) {
    throw Object.assign(new Error(`Run \`squad-sign <frozen-report> --verdict ${report.verdict} --head ${report.headSha} --scope ${report.scope}\` and retry with the token for the current HEAD. Verification failed: ${verification.errors.join("; ")}`), {
      code: "invalid_anti_entropy_receipt",
      origin: "receipt-verify"
    });
  }
  const reviewer: ActorAxes = {
    principal: dependencies.actor.principal,
    executor: { kind: "agent", id: report.reviewerSession }
  };
  const verdict = report.verdict === "rejected" ? "changes_requested" as const : "approved" as const;
  return {
    command: normalizeTaskLifecycleCommand({ workspaceId: dependencies.workspaceId, actor: reviewer, source: "local", expectedRevision }, {
      type: action.commandType,
      taskId: action.taskId,
      executionId: action.executionId,
      reviewId: `review_ae_${report.digest.slice(0, 24)}`,
      kind: "anti_entropy",
      verdict,
      actorRole: "anti_entropy",
      reason: report.reason,
      evidenceChecked: [`anti-entropy-report:sha256:${report.digest}`, `anti-entropy-snapshot:sha256:${report.snapshotDigest}`],
      commitSha: report.headSha,
      iteration: report.iteration,
      archiveWarningsAcknowledged: false
    }),
    verifiedReceipt: Object.freeze({ digest: createHash("sha256").update(action.antiEntropyToken).digest("hex"), [verifiedReceiptBrand]: true as const })
  };
}

function parseAntiEntropyReport(body: string): FrozenAntiEntropyReport {
  const parts = body.split(/^---\s*$/mu);
  if (parts.length !== 2) throw reportError("Frozen report must contain exactly one `---` header separator.");
  const fields = new Map<string, string>();
  for (const line of parts[0]!.split(/\r?\n/u)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/u.exec(line);
    if (!match) continue;
    if (fields.has(match[1]!)) throw reportError(`Frozen report repeats ${match[1]}.`);
    fields.set(match[1]!, match[2]!.trim());
  }
  const required = (name: string): string => {
    const value = fields.get(name);
    if (!nonEmpty(value)) throw reportError(`Frozen report is missing ${name}.`);
    return value;
  };
  if (required("Report-Schema") !== "harness-anti-entropy-report/v1") throw reportError("Frozen report schema must be harness-anti-entropy-report/v1.");
  const headSha = required("Head-SHA");
  const snapshotDigest = required("Snapshot-Digest");
  const reportIteration = Number(required("Iteration"));
  const verdict = required("Verdict");
  if (!/^[0-9a-f]{40}$/u.test(headSha) || !/^[0-9a-f]{64}$/u.test(snapshotDigest)) throw reportError("Frozen report HEAD and snapshot digest must be complete lowercase digests.");
  if (reportIteration !== 1 && reportIteration !== 2) throw reportError("Frozen report Iteration must be the initial round (1) or single rescan (2).");
  if (verdict !== "approved" && verdict !== "rejected") throw reportError("Frozen report Verdict must be approved or rejected.");
  const bodyVerdicts = [...parts[1]!.matchAll(/^Verdict:[ \t]*(approved|rejected)[ \t]*$/gmu)].map((match) => match[1]);
  if (bodyVerdicts.length !== 1 || bodyVerdicts[0] !== verdict) throw reportError("Frozen report body must contain the same single Verdict as its header.");
  const reasonLines = parts[1]!.split(/\r?\n/u)
    .filter((line) => /^(?:Finding|Redo|Observation|Expectation|Evidence):[ \t]*\S/u.test(line))
    .map((line) => line.replace(/^[^:]+:[ \t]*/u, ""));
  if (reasonLines.length === 0) throw reportError("Frozen report must contain Evidence or actionable finding fields for the Review reason.");
  return {
    scope: required("Scope"),
    headSha,
    iteration: (reportIteration - 1) as 0 | 1,
    reviewerSession: required("Reviewer-Session"),
    snapshotDigest,
    verdict,
    reason: reasonLines.join("; "),
    digest: createHash("sha256").update(body).digest("hex")
  };
}

function reportError(message: string): Error {
  return Object.assign(new Error(`${message} Regenerate the immutable report with \`squad-run\`, then sign that exact report with \`squad-sign\`.`), {
    code: "invalid_anti_entropy_report",
    origin: "anti-entropy-report"
  });
}
