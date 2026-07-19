import { Effect, Schema } from "effect";
import {
  consentDeclaration,
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type ConsentAction,
  type ConsentRecord,
  type CurrentSessionRef,
  type HarnessLayoutInput,
  type TaskHolderPrincipal,
  type WriteCoordinator
} from "@harness-anything/kernel";
import { assertExecutionTaskInReview } from "./execution-review-helpers.ts";
import {
  DEFAULT_HUMAN_CONSENT_ACTIONS,
  DEFAULT_HUMAN_CONSENT_TTL_MS,
  createConsentRecord,
  decodeExecutionForConsent,
  generateConsentId
} from "./execution-consent-helpers.ts";
import { consentSourceRequest, resolveConsentAuthorization } from "./consent-source-resolution.ts";
import type { RuntimeLogOptions } from "./runtime-session-logs.ts";

export interface RecordExecutionConsentService {
  readonly recordConsent: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly actor: TaskHolderPrincipal;
    readonly session: CurrentSessionRef;
    readonly utterance?: string;
    readonly standingPolicyDecisionId?: string;
    readonly assertedRationale?: string;
    readonly actions?: ReadonlyArray<ConsentAction>;
  }) => Promise<{ readonly consent: ConsentRecord }>;
}

export function makeRecordExecutionConsentService(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly generateConsentId?: () => string;
  readonly now?: () => string;
  readonly ttlMs?: number;
  readonly runtimeLogOptions?: RuntimeLogOptions;
}): RecordExecutionConsentService {
  const nextConsentId = options.generateConsentId ?? generateConsentId;
  const now = options.now ?? (() => new Date().toISOString());
  const ttlMs = options.ttlMs ?? DEFAULT_HUMAN_CONSENT_TTL_MS;
  return {
    recordConsent: async (input) => {
      const task = await Effect.runPromise(options.artifactStore.readTaskPackage(input.taskId));
      assertExecutionTaskInReview(task.documents, input.taskId);
      const executionDocument = task.documents.find((document) => document.path === `executions/${input.executionId}.md`);
      if (!executionDocument) throw new Error(`execution not found: ${input.executionId}`);
      const execution = decodeExecutionForConsent(executionDocument, input.taskId, input.executionId);
      if (execution.state !== "submitted" || execution.submission === null) {
        throw new Error(`execution is not submitted: ${input.executionId}`);
      }
      const consentId = nextConsentId();
      if (task.documents.some((document) => document.path === `consents/${consentId}.md`)) {
        throw new Error(`consent already exists: ${consentId}`);
      }
      const authorization = await resolveConsentAuthorization({
        rootInput: options.rootInput,
        execution,
        request: consentSourceRequest({
          utterance: input.utterance,
          standingPolicyDecisionId: input.standingPolicyDecisionId,
          assertedRationale: input.assertedRationale
        }),
        runtimeLogOptions: options.runtimeLogOptions
      });
      const consent = createConsentRecord({
        consentId,
        taskId: input.taskId,
        execution,
        actor: input.actor,
        authorization,
        actions: input.actions ?? DEFAULT_HUMAN_CONSENT_ACTIONS,
        grantedAt: now(),
        ttlMs
      });
      const decoded = Schema.decodeUnknownSync(consentDeclaration.schema)(consent) as ConsentRecord;
      const indexDocument = task.documents.find((document) => document.path === "INDEX.md");
      if (!indexDocument) throw new Error(`task INDEX.md missing: ${input.taskId}`);
      await Effect.runPromise(writeDeclaredEntityTransaction(
        options.coordinator,
        stablePayloadHash,
        consentDeclaration,
        { taskId: input.taskId, consentId },
        decoded,
        [],
        [
          { taskId: input.taskId, path: `executions/${input.executionId}.md`, bodySha256: sha256Text(executionDocument.body) },
          { taskId: input.taskId, path: "INDEX.md", bodySha256: sha256Text(indexDocument.body) },
          { taskId: input.taskId, path: `consents/${consentId}.md`, bodySha256: null }
        ]
      ));
      return { consent: decoded };
    }
  };
}
