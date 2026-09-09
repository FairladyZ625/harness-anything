import type { GuiActionResult } from "../api/renderer-dto.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

/**
 * A declared Artifact kind row as `repo.vertical.declaration.read` serves it. Accepted rows carry
 * the stable opaque `kindId`, the append-only `schemaVersions` and their own `revision` fence; a
 * create payload states only the facets — the center mints the identity and version 1.
 */
export interface ArtifactKindDeclaration {
  readonly id: string;
  readonly entityType: "artifact";
  readonly kindId?: string;
  readonly revision?: number;
  readonly schemaVersions?: readonly { readonly version: number; readonly attributes: unknown }[];
  readonly idPrefix: string;
  readonly display: { readonly singular: string; readonly plural: string };
  readonly descriptorSchemaRef: string;
  readonly store: { readonly pathTemplate: string };
  readonly locatorKinds: readonly ("repository-path" | "url" | "external-key")[];
  readonly maturityVocabulary?: readonly string[];
  readonly relations?: readonly unknown[];
  readonly retired?: boolean;
  readonly retiredAt?: string;
  readonly reason?: string;
}

export interface VerticalDeclarationRead {
  readonly schema: "repository-vertical-declaration-read/v1";
  readonly declarationRevision: number;
  readonly declaration: { readonly entityKinds: readonly unknown[] };
}

type VerticalBridge = {
  readonly readVerticalDeclaration: (payload: { readonly repoId: string }) => Promise<unknown>;
  readonly upsertVerticalKind: (payload: object) => Promise<unknown>;
  readonly publishVerticalKindSchema: (payload: object) => Promise<unknown>;
  readonly retireVerticalKind: (payload: object) => Promise<unknown>;
};

const bridge = (): Partial<VerticalBridge> => (window.harness as unknown as Partial<VerticalBridge> | undefined) ?? {};

export async function readVerticalDeclaration(repoId: string): Promise<VerticalDeclarationRead> {
  const channel = bridge().readVerticalDeclaration;
  if (!channel) throw new Error("Vertical declaration bridge is unavailable.");
  const value = await channel({ repoId });
  if (
    !isRendererRecord(value) ||
    value.schema !== "repository-vertical-declaration-read/v1" ||
    !Number.isSafeInteger(value.declarationRevision) ||
    !isRendererRecord(value.declaration) ||
    !Array.isArray(value.declaration.entityKinds)
  )
    throw new Error(rendererErrorHint(value, "Vertical declaration bridge returned an invalid result."));
  return value as unknown as VerticalDeclarationRead;
}

/**
 * The revision the addressed Kind was last accepted at, or `0` when no Kind answers to that name —
 * which is how a caller states the intent to create one. A Kind is its own concurrency subject, so
 * writing a sibling Kind never stales this fence.
 */
export function verticalKindFence(read: VerticalDeclarationRead, kindId: string): number {
  const row = findKindRow(read, kindId);
  return Number.isSafeInteger(row?.revision) ? Number(row?.revision) : 0;
}

/** The one accepted row for a Kind, addressed by opaque identity or qualified name. */
export function findKindRow(read: VerticalDeclarationRead, kindId: string): ArtifactKindDeclaration | null {
  const row = read.declaration.entityKinds.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.entityType === "artifact" &&
      (candidate.kindId === kindId || `entity-kind/${String(candidate.kindId)}` === kindId || candidate.id === kindId),
  );
  return isRecord(row) ? (row as unknown as ArtifactKindDeclaration) : null;
}

export async function upsertVerticalKind(
  repoId: string,
  read: VerticalDeclarationRead,
  declaration: ArtifactKindDeclaration,
): Promise<GuiActionResult> {
  // An existing Kind is addressed by its stable identity, so a rename (a new qualified `id`) reaches
  // the same row instead of creating a second Kind under the new name.
  const existing = findKindRow(read, declaration.kindId ?? declaration.id),
    kindId = existing?.kindId ?? declaration.id;
  if (existing && existing.idPrefix !== declaration.idPrefix)
    throw new Error("idPrefix 不可修改：既有实体 ID 依赖这个前缀。");
  if (existing && existing.store.pathTemplate !== declaration.store.pathTemplate)
    throw new Error("store.pathTemplate 不可修改：既有实体文档依赖这个路径。");
  const channel = bridge().upsertVerticalKind;
  if (!channel) throw new Error("Vertical kind upsert bridge is unavailable.");
  return verticalKindMutationResult(
    channel({
      repoId,
      kindId,
      declaration,
      expectedVersion: verticalKindFence(read, kindId),
    }),
  );
}

/**
 * Publish the next immutable attribute schema version. Bodies already published are never rewritten,
 * so instances keep reading the version they were accepted against.
 */
export async function publishVerticalKindSchema(
  repoId: string,
  read: VerticalDeclarationRead,
  kindId: string,
  attributes: Readonly<Record<string, unknown>>,
): Promise<GuiActionResult> {
  const channel = bridge().publishVerticalKindSchema;
  if (!channel) throw new Error("Vertical kind schema publish bridge is unavailable.");
  return verticalKindMutationResult(
    channel({ repoId, kindId, attributes, expectedVersion: verticalKindFence(read, kindId) }),
  );
}

export async function retireVerticalKind(
  repoId: string,
  read: VerticalDeclarationRead,
  kindId: string,
  reason: string,
): Promise<GuiActionResult> {
  const channel = bridge().retireVerticalKind;
  if (!channel) throw new Error("Vertical kind retire bridge is unavailable.");
  return verticalKindMutationResult(
    channel({ repoId, kindId, reason, expectedVersion: verticalKindFence(read, kindId) }),
  );
}

async function verticalKindMutationResult(request: Promise<unknown>): Promise<GuiActionResult> {
  const value = await request;
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Vertical kind mutation returned an invalid result."));
  return value as unknown as GuiActionResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
