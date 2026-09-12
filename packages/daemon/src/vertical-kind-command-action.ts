import type { RepoCell, RepoTaskAction } from "./repo-cell.ts";

type DeclarationRead = {
  readonly declaration: { readonly entityKinds: readonly unknown[] };
};

/**
 * A Kind is its own concurrency subject. A vertical-kind command that states no `expectedVersion`
 * is fenced here on the addressed Kind's accepted revision (`0` when no Kind answers to that name
 * yet, which is how a caller states the intent to create one), so a caller is never staled by an
 * unrelated Kind someone else wrote and never has to read the declaration first. Immutability of
 * the opaque identity, the id prefix, the store path and every published schema version is the
 * center's judgement, made when the fenced command runs.
 */
export async function resolveVerticalKindCommandAction(
  cell: RepoCell,
  action: RepoTaskAction,
): Promise<RepoTaskAction> {
  if (!isFacade(action)) return action;
  const current = (await cell.read("repo.vertical.declaration.read")) as unknown as DeclarationRead;
  return { ...action, expectedVersion: kindFence(current, String(action.kindId ?? "")) };
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
