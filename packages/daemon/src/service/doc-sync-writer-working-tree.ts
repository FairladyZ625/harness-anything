import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DocSyncSubmitRequestV1 } from "@harness-anything/application";
import {
  resolveHarnessLayout,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

const docSyncWriterWorkingTreeContentKind = "writer-working-tree/v1";

export function referenceDocSyncWriterWorkingTree(
  rootInput: HarnessLayoutInput,
  request: DocSyncSubmitRequestV1
): DocSyncSubmitRequestV1 {
  const layout = resolveHarnessLayout(rootInput);
  return {
    ...request,
    payload: {
      ...request.payload,
      changes: request.payload.changes.map((change) => {
        if (change.content.kind !== "inline"
          || !("body" in change.content)
          || typeof change.content.body !== "string") return change;
        const target = resolveDocSyncChangePath(layout.authoredRoot, change.path);
        if (!target.ok || !existsSync(target.path)) return change;
        const workingTreeBody = readFileSync(target.path, "utf8");
        if (workingTreeBody !== change.content.body) return change;
        return {
          ...change,
          content: { kind: docSyncWriterWorkingTreeContentKind }
        };
      })
    }
  };
}

export function materializeDocSyncWriterWorkingTree(
  rootInput: HarnessLayoutInput,
  request: DocSyncSubmitRequestV1
): { readonly ok: true; readonly request: DocSyncSubmitRequestV1 }
  | { readonly ok: false; readonly reason: string } {
  const layout = resolveHarnessLayout(rootInput);
  const changes = [];
  for (const change of request.payload.changes) {
    if (change.content.kind !== docSyncWriterWorkingTreeContentKind) {
      changes.push(change);
      continue;
    }
    const target = resolveDocSyncChangePath(layout.authoredRoot, change.path);
    if (!target.ok) return { ok: false, reason: `${change.path}: ${target.reason}` };
    try {
      changes.push({
        ...change,
        content: { kind: "inline" as const, body: readFileSync(target.path, "utf8") }
      });
    } catch (error) {
      return {
        ok: false,
        reason: `${change.path}: writer child could not read the canonical working-tree file: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
  }
  return {
    ok: true,
    request: { ...request, payload: { ...request.payload, changes } }
  };
}

export function resolveDocSyncChangePath(
  authoredRoot: string,
  pathInput: string
): { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string } {
  if (path.isAbsolute(pathInput)) {
    return { ok: false, reason: "doc sync path must be authored-root relative" };
  }
  const normalized = pathInput.split(/[\\/]+/u).filter(Boolean).join("/");
  if (normalized.includes("..")) {
    return { ok: false, reason: "doc sync path traversal is forbidden" };
  }
  const absolute = path.resolve(authoredRoot, normalized);
  const relative = path.relative(authoredRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: "doc sync path is outside authored root" };
  }
  return { ok: true, path: absolute };
}
