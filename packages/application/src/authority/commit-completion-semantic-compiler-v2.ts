import {
  sha256Text,
  type EntityId,
  type RegistryMutationPlanInput,
  type WriteOp
} from "@harness-anything/kernel";
import { taskCompletionEvidenceDeclaration } from "../task-completion-authority.ts";
import type { CommitCompletionActionPayloadV2 } from "./session-execution-review-command-v2.ts";
import type { SessionExecutionReviewAuthorityStateV2 } from "./session-execution-review-semantic-compiler-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import { semanticAdmissionV2 as admission, semanticMutationPlanV2 as plan } from "./semantic-authority-helpers-v2.ts";

export async function compileCommitCompletion(
  state: SessionExecutionReviewAuthorityStateV2,
  payload: CommitCompletionActionPayloadV2
): Promise<{
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<{ readonly registryVersion: 1; readonly entityKind: string; readonly canonicalRef: string }>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}> {
  if (payload.evidence.taskId !== payload.taskId || payload.evidence.mode !== "commit-anchor") {
    throw admission("COMMIT_COMPLETION_EVIDENCE_IDENTITY_INVALID");
  }
  const taskPath = `tasks/${encodeURIComponent(payload.taskId)}/INDEX.md`;
  const taskSnapshot = await state.readHostedDocument(taskPath);
  if (!taskSnapshot || !/^  status:\s*(planned|active|blocked|in_review)$/mu.test(taskSnapshot.body)) {
    throw admission("COMMIT_COMPLETION_TASK_NOT_OPEN");
  }
  const expectedTaskBody = taskSnapshot.body.replace(/^(  status:\s*).+$/mu, "$1done");
  if (payload.taskIndexBody !== expectedTaskBody) throw admission("COMMIT_COMPLETION_TASK_TRANSITION_INVALID");
  const contractPath = `tasks/${encodeURIComponent(payload.taskId)}/task-contract.json`;
  const contractSnapshot = await state.readHostedDocument(contractPath);
  const contractDigest = contractSnapshot ? sha256Text(contractSnapshot.body) : null;
  if (contractDigest !== payload.completionContractBodySha256) throw admission("COMMIT_COMPLETION_CONTRACT_CHANGED");
  const closeoutPath = `tasks/${encodeURIComponent(payload.taskId)}/closeout.md`;
  const codeDocPath = `tasks/${encodeURIComponent(payload.taskId)}/code-doc-anchors.json`;
  const closeoutSnapshot = await state.readHostedDocument(closeoutPath);
  const codeDocSnapshot = await state.readHostedDocument(codeDocPath);
  if (!closeoutSnapshot || !codeDocSnapshot) throw admission("COMMIT_COMPLETION_TASK_TRANSITION_INVALID");
  return {
    mutationPlan: plan([{
      entityKind: "task", identity: { taskId: payload.taskId }, action: "transition",
      storageContext: { documentPath: "INDEX.md" }
    }]),
    operation: {
      opId: "authority-overrides-this",
      entityId: `entity/task/${payload.taskId}` as EntityId,
      kind: "doc_write",
      payload: {
        entityDocument: {
          declaration: {
            kind: taskCompletionEvidenceDeclaration.kind,
            storageForm: taskCompletionEvidenceDeclaration.storageForm,
            rootResolver: taskCompletionEvidenceDeclaration.rootResolver
          },
          identity: { taskId: payload.taskId },
          body: taskCompletionEvidenceDeclaration.documentCodec.encode(payload.evidence)
        },
        companionWrites: [{ taskId: payload.taskId, path: "INDEX.md", body: payload.taskIndexBody }],
        preconditions: [
          { taskId: payload.taskId, path: "INDEX.md", bodySha256: sha256Text(taskSnapshot.body) },
          { taskId: payload.taskId, path: "task-contract.json", bodySha256: contractDigest },
          { taskId: payload.taskId, path: "closeout.md", bodySha256: sha256Text(closeoutSnapshot.body) },
          { taskId: payload.taskId, path: "code-doc-anchors.json", bodySha256: sha256Text(codeDocSnapshot.body) }
        ]
      }
    },
    requiredBaseRefs: [{ registryVersion: 1, entityKind: "task", canonicalRef: `task/${payload.taskId}` }],
    requiredPathSnapshots: [
      { path: taskPath, snapshot: taskSnapshot },
      ...(contractSnapshot ? [{ path: contractPath, snapshot: contractSnapshot }] : [{ path: contractPath, snapshot: absentSnapshot(contractPath) }]),
      { path: closeoutPath, snapshot: closeoutSnapshot },
      { path: codeDocPath, snapshot: codeDocSnapshot }
    ]
  };
}

function absentSnapshot(path: string): HostedDocumentSnapshotV2 {
  const digest = sha256Text(`harness-absent-hosted-document/v1:${path}`);
  return { body: "", epoch: digest, revision: 0n, blobDigest: Buffer.from(digest, "hex") };
}
