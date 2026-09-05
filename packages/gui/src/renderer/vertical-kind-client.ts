import type { GuiActionResult } from "../api/renderer-dto.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

export interface ArtifactKindDeclaration {
  readonly id: string;
  readonly entityType: "artifact";
  readonly version: number;
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

export async function upsertVerticalKind(
  repoId: string,
  read: VerticalDeclarationRead,
  declaration: ArtifactKindDeclaration,
): Promise<GuiActionResult> {
  const existing = read.declaration.entityKinds.find(
    (candidate) => isRecord(candidate) && candidate.id === declaration.id,
  );
  if (isRecord(existing) && existing.idPrefix !== declaration.idPrefix)
    throw new Error("idPrefix 不可修改：既有实体 ID 依赖这个前缀。");
  if (isRecord(existing) && isRecord(existing.store) && existing.store.pathTemplate !== declaration.store.pathTemplate)
    throw new Error("store.pathTemplate 不可修改：既有实体文档依赖这个路径。");
  const channel = bridge().upsertVerticalKind;
  if (!channel) throw new Error("Vertical kind upsert bridge is unavailable.");
  return mutationResult(
    channel({
      repoId,
      kindId: declaration.id,
      declaration,
      expectedVersion: read.declarationRevision,
    }),
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
  return mutationResult(channel({ repoId, kindId, reason, expectedVersion: read.declarationRevision }));
}

async function mutationResult(request: Promise<unknown>): Promise<GuiActionResult> {
  const value = await request;
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Vertical kind mutation returned an invalid result."));
  return value as unknown as GuiActionResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
