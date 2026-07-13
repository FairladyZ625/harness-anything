import type { EntityId } from "../domain/index.ts";
import type { JournalRecordKind, ReadableJournalRecord } from "./write-journal-types.ts";

export function writeJournalRecordCommitSummary(
  record: ReadableJournalRecord,
  payload: Record<string, unknown>
): string {
  const parsed = parseEntityLabel(record.entityId);
  const detail = recordCommitDetail(record.kind, payload);
  return `${parsed.kind}(${writeKindVerb(record.kind)}): ${parsed.id}${detail ? ` ${detail}` : ""}`;
}

function parseEntityLabel(entityId: EntityId): { readonly kind: string; readonly id: string } {
  const separator = entityId.indexOf("/");
  if (separator < 0) return { kind: "write", id: entityId };
  return { kind: entityId.slice(0, separator), id: entityId.slice(separator + 1) };
}

function writeKindVerb(kind: JournalRecordKind): string {
  return kind
    .replace(/^decision_/u, "")
    .replace(/^package_/u, "")
    .replace(/_local$/u, "")
    .replace(/^module_/u, "")
    .replace(/_write$/u, "")
    .replace(/_/gu, "-");
}

function recordCommitDetail(kind: JournalRecordKind, payload: Record<string, unknown>): string {
  if (kind === "transition_local" && typeof payload.to === "string") return `-> ${payload.to}`;
  if (kind === "progress_append") return "progress.md";
  if ((kind === "machine_artifact_write" || kind === "machine_artifact_append_jsonl") && typeof payload.path === "string") return payload.path;
  if ((kind === "doc_write" || kind === "doc_stage" || kind === "code_doc_reconcile") && typeof payload.path === "string") return payload.path;
  if (kind === "task_tree_stage") return "task package";
  if (kind === "module_registry_write" && typeof payload.operation === "string") return payload.operation;
  if (kind === "module_scaffold_write") return "scaffold";
  if (kind === "decision_relate") {
    const decision = payload.decision as { readonly relations?: ReadonlyArray<{ readonly type?: unknown; readonly target?: unknown }> } | undefined;
    const relation = decision?.relations?.at(-1);
    if (relation && typeof relation.type === "string" && typeof relation.target === "string") {
      return `${relation.type} ${relation.target.replace(/^decision\//u, "")}`;
    }
  }
  if (kind.startsWith("decision_")) {
    const decision = payload.decision as { readonly title?: unknown } | undefined;
    if (decision && typeof decision.title === "string" && decision.title.trim().length > 0) return decision.title.trim().slice(0, 72);
  }
  return "";
}
