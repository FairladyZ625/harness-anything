import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepoCell, RepoTaskAction } from "./repo-cell.ts";

type DeclarationRead = {
  readonly declaration: { readonly entityKinds: readonly unknown[] };
};

export async function resolveVerticalKindCommandAction(
  cell: RepoCell,
  action: RepoTaskAction,
): Promise<RepoTaskAction> {
  if (!isFacade(action)) return action;
  const current = (await cell.read("repo.vertical.declaration.read")) as unknown as DeclarationRead,
    kindId = String(action.kindId ?? "");
  if (action.kind === "vertical-kind-retire") return { ...action, expectedVersion: kindFence(current, kindId) };
  const source = String(action.fromFile ?? ""),
    file = path.isAbsolute(source) ? source : path.join(cell.status().rootDir, source);
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`--from-file could not be read as JSON: ${verticalKindErrorText(error)}`), {
      code: "invalid_field",
    });
  }
  if (!isVerticalKindRecord(body))
    throw Object.assign(new Error("--from-file must contain one JSON object."), { code: "invalid_field" });
  const { fromFile: _fromFile, ...resolved } = action;
  if (action.kind === "vertical-kind-publish-schema")
    return { ...resolved, attributes: body, expectedVersion: kindFence(current, kindId) };
  if (body.entityType !== "artifact" || typeof body.id !== "string")
    throw Object.assign(new Error("--from-file must contain one complete Artifact kind declaration."), {
      code: "invalid_field",
    });
  const stableKindId = typeof body.kindId === "string" ? body.kindId : body.id;
  return {
    ...resolved,
    kindId: stableKindId,
    declaration: body,
    expectedVersion: kindFence(current, stableKindId),
  };
}

function isFacade(action: RepoTaskAction): boolean {
  return (
    ["vertical-kind-upsert", "vertical-kind-publish-schema", "vertical-kind-retire"].includes(action.kind) &&
    !("expectedVersion" in action)
  );
}

function kindFence(read: DeclarationRead, kindId: string): number {
  const row = read.declaration.entityKinds.find(
    (candidate) =>
      isVerticalKindRecord(candidate) &&
      candidate.entityType === "artifact" &&
      (candidate.kindId === kindId || `entity-kind/${String(candidate.kindId)}` === kindId || candidate.id === kindId),
  ) as { readonly revision?: unknown } | undefined;
  return Number.isSafeInteger(row?.revision) ? Number(row?.revision) : 0;
}

function isVerticalKindRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verticalKindErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
