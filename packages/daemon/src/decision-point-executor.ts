import { createHash } from "node:crypto";
import {
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
  type VerticalDefinition,
} from "@harness-anything/kernel";
import type { RepoCell } from "./repo-cell-types.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { decisionAdvisoryFromProvider, openDecisionAnnotationStore } from "./decision-annotations.ts";

type OutcomeEvent = Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>;
type DecisionPort = { readonly decide: (request: DecisionRequest) => Promise<AdvisoryDecision> };

export function openDecisionPointExecutor(input: {
  readonly rootDir: string;
  readonly providers: { readonly list: () => readonly DecisionProviderRecord[]; readonly port: DecisionPort };
  readonly now: () => string;
}) {
  const annotations = openDecisionAnnotationStore(input.rootDir);
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
        const descriptor = decisionEventDescriptor(point.on);
        if (!descriptor?.finalOnly) continue;
        const bindingDigest = decisionPointBindingDigest(pointId, point, question);
        if (!enabledPoints.includes(`${pointId}@${bindingDigest.slice(0, 12)}`)) continue;
        const projected = projectDecisionInput({ point, event, report: sessionResult.result.text });
        if (!projected) continue;
        const model = provider?.model ?? null,
          inputDigest = createHash("sha256").update(projected.state, "utf8").digest("hex"),
          key = createHash("sha256")
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
              fields: projected.fields,
              providerId,
              model,
              sentAt,
              inputDigest,
            },
          });
        if (!claim.created) continue;
        if (!provider) {
          await annotations.fail(key, "provider_not_found", input.now());
          continue;
        }
        if (!provider.enabled) {
          await annotations.fail(key, "provider_disabled", input.now());
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
      }
    },
  };
}

export function projectDecisionInput(input: {
  readonly point: DecisionPointDeclaration;
  readonly event: OutcomeEvent;
  readonly report: string;
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
    }
  }
  return segments.length === 0 ? null : { state: segments.join("\n"), fields };
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
