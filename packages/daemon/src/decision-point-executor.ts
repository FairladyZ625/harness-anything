import { createHash } from "node:crypto";
import {
  consumeKnownError,
  decisionPointBindingDigest,
  decisionEventDescriptor,
  decisionWhenMatches,
  stableStringify,
  type AdvisoryDecision,
  type AgentRuntimeEventV1,
  type DecisionPointDeclaration,
  type DecisionInputField,
  type DecisionQuestion,
  type DecisionQuestionDeclaration,
  type DecisionRequest,
  type DecisionProviderRecord,
  type SettingsV1,
  type TaskProjectionQueries,
  type VerticalDefinition,
} from "@harness-anything/kernel";
import type { TaskDispatchRow } from "./protocol/task-dispatch-contract.ts";
import type { RepoCell } from "./repo-cell-types.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { decisionAdvisoryFromProvider, openDecisionAnnotationStore } from "./decision-annotations.ts";
import {
  appendIncidentActionReceipt,
  countAppliedIncidentActions,
  readIncidentActionReceipt,
} from "./decision-incident-receipt.ts";
import type { DaemonTaskRuntimeContextResult } from "./protocol/daemon-protocol-runtime-context.ts";
import { readEffectiveReviewReturnBudget } from "./repo-cell-settings-state.ts";
import {
  defaultIncidentDisposition,
  executeIncidentAction,
  incidentActionBinding,
  incidentDecisionFields,
  incidentDispositionQuestionVersion,
  planIncidentAction,
  type IncidentActionEvidence,
  type IncidentActionPlan,
  type IncidentDecisionFields,
} from "./decision-incident-action.ts";
import type { RuntimeOperatorSession } from "./runtime-online-binding.ts";

type OutcomeEvent = Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
type DecisionPort = { readonly decide: (request: DecisionRequest) => Promise<AdvisoryDecision> };

export function openDecisionPointExecutor(input: {
  readonly rootDir: string;
  readonly providers: { readonly list: () => readonly DecisionProviderRecord[]; readonly port: DecisionPort };
  readonly now: () => string;
  /** The daemon's current local operator session, the same source a manual runtime launch uses. */
  readonly keycloakSession: () => Promise<RuntimeOperatorSession>;
}) {
  const annotations = openDecisionAnnotationStore(input.rootDir);
  // The single settlement path every executable disposition funnels into: the durable dispatch
  // receipt is projected as the existing awaiting-ruling agenda item when, and only when, the
  // executed action is an owner escalation.
  const settle = async (args: {
    readonly cell: RepoCell;
    readonly key: string;
    readonly taskId: string;
    readonly dispatchId: string;
    readonly pointId: string;
    readonly questionVersion: string;
    readonly selected: string;
    readonly plan: IncidentActionPlan;
    /** Why a provider-less disposition was chosen; the executed action carries no reason of its
     * own, and the receipt must still say the Decisions API was unavailable. */
    readonly note: string | null;
    readonly budget: IncidentDecisionFields["reworkBudget"] | null;
  }): Promise<void> => {
    const outcome = await executeIncidentAction({
        cell: args.cell,
        plan: args.plan,
        binding: incidentActionBinding(input.rootDir, args.dispatchId),
        dispatchId: args.dispatchId,
        keycloakSession: input.keycloakSession,
      }),
      decidedAt = input.now(),
      reason = outcome.reason ?? args.note;
    await annotations.settleAction(
      args.key,
      {
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        selected: args.selected,
        action: outcome.action,
        status: outcome.status,
        reason,
        successorDispatchId: outcome.successorDispatchId,
        budget: args.budget,
      },
      decidedAt,
    );
    // The canonical receipt is what the dispatch read and the budget fence consume; the annotation
    // claim above is the audit copy and may be evicted by its retention window.
    appendIncidentActionReceipt(input.rootDir, args.dispatchId, {
      pointId: args.pointId,
      questionVersion: args.questionVersion,
      status: outcome.status === "applied" ? "applied" : "failed",
      selected: args.selected,
      action: outcome.action,
      reason,
      successorDispatchId: outcome.successorDispatchId,
      budget: args.budget,
      decidedAt,
    });
  };
  return {
    async settle(cell: RepoCell, event: OutcomeEvent): Promise<void> {
      const dispatchId = event.payload.dispatchId;
      if (!dispatchId || event.payload.attempt?.fallbackState === "scheduled") return;
      const sessionResult = await cell.read("repo.agentRuntime.sessions.read", {
          runtimeSessionId: event.payload.runtimeSessionId,
        }),
        task = sessionResult.session.associations[0];
      if (sessionResult.status !== "ready" || !task || !sessionResult.result) return;
      const dispatchRead = await cell.read("repo.task.dispatches", { taskId: task.taskId }),
        dispatch = dispatchRead.dispatches.find((row) => row.dispatchId === dispatchId);
      if (
        !dispatch ||
        dispatch.fallbackState === "scheduled" ||
        dispatch.fallbackState === "dispatched" ||
        dispatch.nextDispatchId
      )
        return;

      const [verticalRead, settingsRead] = await Promise.all([
          cell.read("repo.vertical.declaration.read"),
          cell.read("repo.settings.read"),
        ]),
        vertical = verticalRead.declaration,
        decisions = settingsRead.settings.decisions,
        providerId = decisions?.provider,
        enabledPoints = decisions?.enabledPoints ?? [];
      if (!vertical.decisions || !providerId || enabledPoints.length === 0) return;
      const provider = input.providers.list().find((candidate) => candidate.providerId === providerId);

      const eventFields = {
          outcome: event.payload.outcome,
          classification: event.payload.attempt?.classification ?? null,
        } as const,
        points = Object.entries(vertical.decisions.points).filter(([, point]) =>
          decisionWhenMatches(point.when, eventFields),
        );
      for (const [pointId, point] of points) {
        const question = vertical.decisions.questions[point.question];
        if (!question) continue;
        // A successful terminal outcome is delivered work (including registered review work), so
        // the incident action must not reopen it even when an older frozen filter still matches.
        if (
          question.version === incidentDispositionQuestionVersion &&
          event.payload.outcome !== "failed" &&
          event.payload.outcome !== "stopped"
        )
          continue;
        const descriptor = decisionEventDescriptor(point.on);
        if (!descriptor?.finalOnly) continue;
        const bindingDigest = decisionPointBindingDigest(pointId, point, question);
        if (!enabledPoints.includes(`${pointId}@${bindingDigest.slice(0, 12)}`)) continue;
        const executable = question.version === incidentDispositionQuestionVersion,
          incident = executable
            ? await readIncidentFields(
                cell,
                input.rootDir,
                task.taskId,
                dispatchRead.dispatches,
                event,
                settingsRead.settings,
              )
            : null,
          projected =
            incident === null
              ? projectDecisionInput({ point, event, report: sessionResult.result.text })
              : incident.fields
                ? projectDecisionInput({
                    point,
                    event,
                    report: sessionResult.result.text,
                    incident: incident.fields,
                  })
                : null;
        if (!projected && !executable) continue;
        const model = provider?.model ?? null,
          inputDigest =
            projected === null
              ? "incident-input-unavailable"
              : createHash("sha256").update(projected.state, "utf8").digest("hex"),
          // The claim key names the incident, never a measurement: rounds used, HEAD and budget
          // all move between observations, and a key built from them would mint a fresh claim for
          // the same dispatch. task + dispatch + point + question is the whole incident identity.
          key = executable
            ? `incident-action/${createHash("sha256")
                .update(
                  stableStringify({
                    taskId: task.taskId,
                    dispatchId,
                    pointId,
                    questionVersion: question.version,
                  }),
                  "utf8",
                )
                .digest("hex")}`
            : createHash("sha256")
                .update(
                  stableStringify({
                    pointId,
                    questionVersion: question.version,
                    inputDigest,
                    providerModel: `${providerId}:${model ?? ""}`,
                  }),
                  "utf8",
                )
                .digest("hex"),
          subjectRef = `dispatch/${dispatchId}`,
          sentAt = input.now(),
          claim = await annotations.reserve({
            key,
            pointId,
            questionVersion: question.version,
            bindingDigest,
            event: point.on,
            show: point.show,
            dispatchId,
            subjectRef,
            now: sentAt,
            egress: {
              subjectRef,
              dispatchId,
              pointId,
              fields: projected?.fields ?? [],
              providerId,
              model,
              sentAt,
              inputDigest,
            },
          });
        if (!claim.created) continue;
        const snapshot = incident?.runtimeContext?.snapshot,
          incidentTask = snapshot?.task ?? null,
          evidence: IncidentActionEvidence = {
            submitted:
              incidentTask !== null &&
              (snapshot?.executions ?? []).some(
                (execution) => execution.submission !== null && execution.iteration === incidentTask.iteration,
              ),
            successorActive: dispatchRead.dispatches.some(
              (row) => row.status === "running" || row.status === "blocked",
            ),
            leaseOccupied: snapshot?.lease != null,
            resumable: Boolean(dispatch?.resume),
            agentId: dispatch?.agentId ?? null,
            budgetRemaining: incident?.fields
              ? incident.fields.reworkBudget.limit - incident.fields.reworkBudget.used
              : 0,
            // A continuation inherits the worktree; with no measured HEAD there is no known base
            // to continue from, so automatic execution is not admissible.
            headKnown: incident?.fields !== undefined && incident.fields.headStatus !== "unavailable",
          },
          recordBudget = incident?.fields?.reworkBudget ?? null,
          apply = (selected: string, plan: IncidentActionPlan, note: string | null) =>
            settle({
              cell,
              key,
              taskId: task.taskId,
              dispatchId,
              pointId,
              questionVersion: question.version,
              selected,
              plan,
              note,
              budget: recordBudget,
            }),
          escalate = (guard: string) =>
            apply(
              "needs_attention",
              {
                action: "needs_attention",
                guard,
                rationale: `question: Decisions API could not safely select an incident action for dispatch ${dispatchId}: ${guard}`,
              },
              null,
            ),
          /** The provider is an accelerator, never the only route to a disposition: when it cannot
           * answer, the preference list picks the option and the same gate decides whether it is
           * admissible. The receipt keeps the provider failure in its reason. */
          applyDefault = (failure: string) => {
            const unavailable = `Decisions API unavailable (${failure})`,
              fallback = defaultIncidentDisposition({ taskId: task.taskId, dispatchId, evidence });
            if (fallback.kind === "escalate")
              return apply(
                "needs_attention",
                {
                  action: "needs_attention",
                  guard: fallback.guard,
                  rationale: `question: ${fallback.guard} ${unavailable}.`,
                },
                null,
              );
            return apply(
              fallback.selected,
              fallback.plan,
              `${unavailable}; applied the deterministic default disposition "${fallback.selected}".`,
            );
          };
        if (executable) {
          // The durable fence outlives the annotation store's retention window. A settled receipt
          // means an earlier observation already executed this dispatch's disposition; a `claimed`
          // fence without settlement means the launch outcome is unknown, which is owner business,
          // never a reason to launch again.
          const priorReceipt = readIncidentActionReceipt(input.rootDir, dispatchId);
          if (priorReceipt?.status === "claimed") {
            await escalate("a previous disposition was claimed but never settled, so the launch outcome is unknown.");
            continue;
          }
          if (priorReceipt !== null) continue;
          // Pre-action fence on the dispatch's own durable record: a crash between this line and
          // the settled receipt leaves a visible `claimed` disposition instead of a silent replay.
          appendIncidentActionReceipt(input.rootDir, dispatchId, {
            pointId,
            questionVersion: question.version,
            status: "claimed",
            decidedAt: input.now(),
          });
        }
        if (!projected) {
          // Executable contracts never fire the provider on an unreadable incident input.
          await annotations.fail(key, "incident_input_unavailable", input.now());
          await escalate(`the incident input could not be projected: ${incident?.failure ?? "unknown read failure"}`);
          continue;
        }
        if (!provider) {
          await annotations.fail(key, "provider_not_found", input.now());
          if (executable) await applyDefault("the configured Decisions provider does not exist");
          continue;
        }
        if (!provider.enabled) {
          await annotations.fail(key, "provider_disabled", input.now());
          if (executable) await applyDefault("the configured Decisions provider is disabled");
          continue;
        }
        let answer: AdvisoryDecision;
        try {
          answer = await input.providers.port.decide({
            subjectRef,
            providerId,
            questionSetVersion: question.version,
            state: [projected.state],
            question: questionForProvider(question),
          });
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
              ? error.code
              : "decision_error";
          await annotations.fail(key, code, input.now());
          const retries =
            typeof error === "object" && error !== null && "retries" in error && typeof error.retries === "number"
              ? error.retries
              : null;
          if (executable)
            await applyDefault(
              `the Decisions provider failed with ${code}${
                retries === null
                  ? ""
                  : ` after ${String(retries)} retries: ${error instanceof Error ? error.message : ""}`
              }`,
            );
          consumeKnownError(error);
          continue;
        }
        await annotations.succeed(
          key,
          decisionAdvisoryFromProvider(answer, {
            pointId,
            questionVersion: question.version,
            options: question.type === "choice" ? question.options : question.type === "score" ? question.levels : [],
          }),
          input.now(),
        );
        if (executable && incident !== null) {
          const selected = answer.result.type === "choice" ? answer.result.selected : "";
          await apply(selected, planIncidentAction({ selected, taskId: task.taskId, dispatchId, evidence }), null);
        }
      }
    },
  };
}

interface IncidentRead {
  readonly runtimeContext: DaemonTaskRuntimeContextResult | null;
  readonly fields: IncidentDecisionFields | undefined;
  readonly failure: string | null;
}

/** One incident-context read at the projection cut: continuation seed and worktree HEAD reuse
 * task_3fedf360's construction, the budget comes from the single effective-budget source, and
 * the used count is this task's applied automatic dispositions so far. */
async function readIncidentFields(
  cell: RepoCell,
  rootDir: string,
  taskId: string,
  dispatches: readonly TaskDispatchRow[],
  event: OutcomeEvent,
  settings: SettingsV1,
): Promise<IncidentRead> {
  try {
    const runtimeContext = await cell.read("repo.tasks.runtimeContext.read", { taskId }),
      toolCallCount = event.payload.runtimeMetrics?.toolCallCount,
      fields = await incidentDecisionFields({
        rootDir,
        runtimeContext,
        dispatchCount: dispatches.length,
        toolCallCount: typeof toolCallCount === "number" ? toolCallCount : null,
        effectiveBudget: readEffectiveReviewReturnBudget({
          // The merged settings facet carries repository-owned fields verbatim; the function
          // itself still owns the absent-entity default, so no default is copied here. Only
          // `.value` is read on this row.
          getEntity: (kind: string, id: string) =>
            kind === "settings" && id === "repository"
              ? // Only `.value` is read on this row; the surrounding entity freshness fields are
                // not part of the effective-budget read.
                ({ value: settings } as unknown as ReturnType<TaskProjectionQueries["getEntity"]>)
              : null,
        }),
        // The budget fence counts durable receipts on canonical dispatch rows, not the local
        // annotation store: that store truncates to its newest entries and would let a busy
        // repository forget old automatic dispositions and reopen the cap.
        used: countAppliedIncidentActions(dispatches),
      });
    return {
      runtimeContext,
      fields,
      failure: null,
    };
  } catch (error) {
    consumeKnownError(error);
    return {
      runtimeContext: null,
      fields: undefined,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

export function projectDecisionInput(input: {
  readonly point: DecisionPointDeclaration;
  readonly event: {
    readonly payload: { readonly attempt?: { readonly reason?: string; readonly classification?: string } };
  };
  readonly report: string;
  readonly incident?: IncidentDecisionFields;
}): { readonly state: string; readonly fields: readonly DecisionInputField[] } | null {
  const descriptor = decisionEventDescriptor(input.point.on);
  if (!descriptor?.finalOnly) return null;
  if (!input.report.trim() || isExplicitlyTruncated(input.report)) return null;
  const segments: string[] = [],
    fields: DecisionInputField[] = [];
  // Keep short structured context first and the free-form report last, regardless of declaration
  // order. This is the pilot B projection contract and gives the model a clear field boundary.
  for (const field of [
    ...input.point.input.filter((candidate) => candidate !== "report.body"),
    ...input.point.input.filter((candidate) => candidate === "report.body"),
  ]) {
    const fieldDescriptor = descriptor.inputFields[field];
    if (!fieldDescriptor) continue;
    if (field === "report.body") {
      segments.push(`report: ${projectFieldValue(input.report, fieldDescriptor)}`);
      fields.push(field);
    } else if (field === "dispatch.reason") {
      const reason = input.event.payload.attempt?.reason;
      if (reason) {
        segments.push(`reason: ${projectFieldValue(reason, fieldDescriptor)}`);
        fields.push(field);
      }
    } else if (field === "dispatch.classification") {
      const classification = input.event.payload.attempt?.classification;
      if (classification) {
        segments.push(`classification: ${projectFieldValue(classification, fieldDescriptor)}`);
        fields.push(field);
      }
    } else {
      const segment = incidentFieldSegment(field, input.incident, fieldDescriptor);
      if (segment) {
        segments.push(segment);
        fields.push(field);
      }
    }
  }
  return segments.length === 0 ? null : { state: segments.join("\n"), fields };
}

/** Structured incident fields are daemon-measured: unavailable is a measured value and stays in
 * the projection; only a missing incident context (the caller could not read it) drops a field. */
function incidentFieldSegment(
  field: DecisionInputField,
  incident: IncidentDecisionFields | undefined,
  descriptor: { readonly maxLength: number; readonly redactionRevision: string },
): string | null {
  if (incident === undefined) return null;
  switch (field) {
    case "runtime.toolCallCount":
      return `tool_call_count: ${incident.toolCallCount == null ? "unavailable" : String(incident.toolCallCount)}`;
    case "runtime.headStatus":
      return `head_status: ${incident.headStatus}`;
    case "runtime.lastConclusion":
      return incident.lastConclusion === null
        ? "last_conclusion: unavailable"
        : `last_conclusion: ${projectFieldValue(incident.lastConclusion, descriptor)}`;
    case "runtime.exitHead":
      return `exit_head: ${incident.exitHead ?? "unavailable"}`;
    case "runtime.currentHead":
      return `current_head: ${incident.currentHead ?? "unavailable"}`;
    case "task.roundsUsed":
      return `rounds_used: ${String(incident.roundsUsed)}`;
    case "task.reworkBudget":
      return `rework_budget: used=${String(incident.reworkBudget.used)} limit=${String(incident.reworkBudget.limit)} source=${incident.reworkBudget.source}`;
    default:
      return null;
  }
}

function projectFieldValue(
  value: string,
  descriptor: { readonly maxLength: number; readonly redactionRevision: string },
): string {
  if (descriptor.redactionRevision === "report-summary-v1") {
    const normalized = redactText(value).replace(/\s+/gu, " ").trim();
    if (normalized.length <= descriptor.maxLength) return normalized;
    const head = Math.floor((descriptor.maxLength * 3) / 5),
      tail = descriptor.maxLength - head;
    return `${normalized.slice(0, head)}\n……[中略]……\n${normalized.slice(-tail)}`;
  }
  if (descriptor.redactionRevision === "plain-text-v1") return redactText(value).slice(0, descriptor.maxLength);
  if (descriptor.redactionRevision === "vocabulary-v1") return value.slice(0, descriptor.maxLength);
  throw new Error(`Unknown Decisions input redaction revision ${descriptor.redactionRevision}.`);
}

function redactText(value: string): string {
  return String(scrubProviderValue(value)).replace(
    /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/gu,
    "[LOCAL_PATH]",
  );
}

function isExplicitlyTruncated(value: string): boolean {
  return /(?:\[\s*(?:report\s+)?truncated\s*\]|<report\b[^>]*\btruncated\s*=\s*["']true["']|…\s*\[truncated\s*\]…)/iu.test(
    value,
  );
}

function questionForProvider(question: DecisionQuestionDeclaration): DecisionQuestion {
  if (question.type === "noul") return question;
  if (question.type === "choice") return question;
  return question;
}

export function decisionPointBindingDigestForVertical(vertical: VerticalDefinition, pointId: string): string | null {
  const point = vertical.decisions?.points[pointId],
    question = point && vertical.decisions?.questions[point.question];
  return point && question ? decisionPointBindingDigest(pointId, point, question) : null;
}

export function openDecisionPointExecutorFactory(input: {
  readonly providers: { readonly list: () => readonly DecisionProviderRecord[]; readonly port: DecisionPort };
  readonly now: () => string;
  readonly keycloakSession: () => Promise<RuntimeOperatorSession>;
}) {
  const executors = new Map<
    string,
    { readonly rootDir: string; readonly executor: ReturnType<typeof openDecisionPointExecutor> }
  >();
  return (repoId: string, rootDir: string) => {
    const current = executors.get(repoId);
    if (current?.rootDir === rootDir) return current.executor;
    const executor = openDecisionPointExecutor({ ...input, rootDir });
    executors.set(repoId, { rootDir, executor });
    return executor;
  };
}
