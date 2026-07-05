/** @slice-activation M3 TP-03a will consume this minimal resolver when WriteOp.taskId is generalized to EntityRef. */
import path from "node:path";
import { parseEntityRef, type ParsedEntityRef } from "../domain/entity-ref.ts";
import type { TaskId } from "../domain/index.ts";
import { normalizeRelativeDocumentPath } from "./portable-path.ts";
import type { HarnessLayout } from "./index.ts";

export type EntityRootIntent = "read" | "write";

export interface EntityRootResolution {
  readonly entityRef: ParsedEntityRef;
  readonly rootPath: string;
  readonly documentPath: string;
  readonly anchor?: string;
}

export function resolveEntityRootForLayout(
  layout: HarnessLayout,
  ref: string | ParsedEntityRef,
  _intent: EntityRootIntent = "read"
): EntityRootResolution {
  const entityRef = typeof ref === "string" ? parseEntityRef(ref) : ref;
  if (!entityRef) throw new Error(`invalid entity ref: ${String(ref)}`);
  if (entityRef.externalHarness) throw new Error(`external entity ref cannot be resolved locally: ${entityRef.raw}`);
  switch (entityRef.kind) {
    case "task": {
      const rootPath = layout.taskPackagePath(entityRef.id as TaskId);
      return {
        entityRef,
        rootPath,
        documentPath: path.join(rootPath, "INDEX.md"),
        ...(entityRef.anchor ? { anchor: entityRef.anchor } : {})
      };
    }
    case "decision": {
      const decisionId = normalizeEntitySegment(entityRef.id, "decision id");
      const rootPath = layout.decisionPackagePath(decisionId);
      return {
        entityRef,
        rootPath,
        documentPath: layout.decisionDocumentPath(decisionId),
        ...(entityRef.anchor ? { anchor: entityRef.anchor } : {})
      };
    }
    case "fact": {
      const ownerTaskId = entityRef.ownerTaskId;
      if (!ownerTaskId) throw new Error(`fact ref missing owner task id: ${entityRef.raw}`);
      const factId = normalizeEntitySegment(entityRef.id, "fact id");
      const rootPath = layout.taskPackagePath(ownerTaskId as TaskId);
      return {
        entityRef,
        rootPath,
        documentPath: layout.taskFactDocumentPath(ownerTaskId as TaskId),
        anchor: factId
      };
    }
    case "relation":
      throw new Error(`hosted relation refs cannot be resolved without their source host: ${entityRef.raw}`);
  }
}

function normalizeEntitySegment(value: string, label: string): string {
  const normalized = normalizeRelativeDocumentPath(value);
  if (normalized !== value || normalized.includes("/")) {
    throw new Error(`${label} must be a portable single path segment: ${value}`);
  }
  return normalized;
}
