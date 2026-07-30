import { sha256Text } from "@harness-anything/kernel";
import type { TaskTransitionPayloadV2 } from "./task-decision-module-command-v2.ts";
import type { TaskDecisionModuleAuthorityStateV2 } from "./task-decision-module-semantic-compiler-v2.ts";
import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";

export async function taskTransitionCompletionContractSnapshots(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskTransitionPayloadV2
): Promise<ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>> {
  if (payload.completionContractBodySha256 === undefined) return [];
  const path = `tasks/${encodeURIComponent(payload.taskId)}/task-contract.json`;
  const snapshot = await state.readHostedDocument(path);
  if ((snapshot ? sha256Text(snapshot.body) : null) !== payload.completionContractBodySha256) {
    throw admission("TASK_COMPLETION_CONTRACT_CHANGED");
  }
  return [{ path, snapshot: snapshot ?? absentHostedDocument(path) }];
}

function absentHostedDocument(path: string): HostedDocumentSnapshotV2 {
  const digest = sha256Text(`harness-absent-hosted-document/v1:${path}`);
  return {
    body: "",
    epoch: digest,
    revision: 0n,
    blobDigest: Buffer.from(digest, "hex")
  };
}
