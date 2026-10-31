import type { DatabaseSync } from "node:sqlite";
import { decisionDocumentProse } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type { DecisionBodyRow } from "@harness-anything/kernel";
import { prepareQuery } from "./rebuildable-task-projection-sql.ts";

export function readDecisionBody(db: DatabaseSync, decisionId: string): DecisionBodyRow | null {
  const path = `decisions/decision-${decisionId}/decision.md`,
    row = prepareQuery(db, "SELECT value_json FROM document WHERE path=?").get(path) as
      | { readonly value_json: string }
      | undefined;
  return row ? decisionBodyFromDocument(decisionId, row.value_json) : null;
}

export function decisionBodyFromDocument(decisionId: string, valueJson: string): DecisionBodyRow {
  const path = `decisions/decision-${decisionId}/decision.md`,
    document = JSON.parse(valueJson) as DocumentState;
  return {
    path,
    blobSha256: document.blobSha256,
    size: document.size,
    mediaType: document.mediaType,
    body: decisionDocumentProse(document.body),
    workspaceRevision: document.workspaceRevision,
  };
}
