import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyVerticalKindCommand,
  compileVerticalDeclarationEvent,
  decodeVerticalDefinition,
  parseVerticalDeclarationDocument,
  VERTICAL_DECLARATION_PATH,
  type CanonicalEventStore,
  type TaskProjection,
  type VerticalDeclarationDocumentV1,
  type VerticalKindCommandResult,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { noChanges, reject } from "./entity-action-write-helpers.ts";

/** The one projection facility the declaration is read through; nothing here needs wider authority. */
export type VerticalDeclarationReader = Pick<TaskProjection, "readDocument">;

/**
 * The installed Kind state, read from the canonical record the declaration events project. A vertical
 * package is an install seed and `harness/vertical.json` is a materialization of what was accepted, so
 * an edge node whose worktree copy is stale, absent or unpublishable still holds every Kind it
 * accepted — and re-running the migration cannot seed over it.
 */
export function readCanonicalVerticalDeclaration(
  projection: VerticalDeclarationReader,
): VerticalDeclarationDocumentV1 | null {
  const body = projection.readDocument(VERTICAL_DECLARATION_PATH).document?.body;
  return body === undefined ? null : parseVerticalDeclarationDocument(JSON.parse(body));
}

export function requireCanonicalVerticalDeclaration(
  projection: VerticalDeclarationReader,
): VerticalDeclarationDocumentV1 {
  const document = readCanonicalVerticalDeclaration(projection);
  if (document) return document;
  throw Object.assign(
    new Error("Repository has no accepted vertical declaration; run ha migrate vertical-declaration."),
    { code: "vertical_declaration_required" },
  );
}

export async function runVerticalDeclarationAction(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  /** Opaque kind identity is minted at the application boundary; the domain only validates its shape. */
  readonly mintKindId?: () => string;
}): Promise<WriteReceiptDraft> {
  const current = readCanonicalVerticalDeclaration(input.projection);
  if (input.action.kind === "vertical-declaration-migrate" && current)
    return noChanges({
      opId: `vertical-declaration-existing-${current.revision}`,
      revision: current.revision,
      evidence: JSON.stringify({ schema: "vertical-declaration-result/v1", idempotent: true }),
    });
  const nextRevision = (input.store.readHead()?.revision ?? 0) + 1,
    occurredAt = input.now(),
    result = candidate(input.action, current, occurredAt, nextRevision, input.mintKindId ?? mintKindId);
  if (current && JSON.stringify(result.definition) === JSON.stringify(current.definition))
    return noChanges({
      opId: `vertical-declaration-unchanged-${current.revision}`,
      revision: current.revision,
      evidence: JSON.stringify({ schema: "vertical-declaration-result/v1", idempotent: true }),
    });
  const bundle = compileVerticalDeclarationEvent({
      type: result.type,
      definition: result.definition,
      ...(result.kindId ? { kindId: result.kindId } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      eventId: `event-vertical-declaration-${nextRevision}`,
      opId: `vertical-declaration-${result.type}-${nextRevision}`,
      workspaceRevision: nextRevision,
      actor: input.binding.actor,
      source: input.binding.source,
      occurredAt,
    }),
    appended = input.store.append(bundle);
  input.projection.apply(bundle.event, bundle.plan);
  await input.store.settlePendingMaterialization?.("vertical declaration");
  return {
    outcome: "applied",
    opId: bundle.event.opId,
    revision: appended.revision,
    evidence: JSON.stringify({
      schema: "vertical-declaration-result/v1",
      eventType: bundle.event.type,
      kindId: result.kindId,
      kindRef: result.kindRef,
      kindVersion: result.kindVersion,
    }),
    visibility: "center",
    proof: {
      committedRevision: appended.revision,
      appliedCut: appended.revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
    ...(input.binding.authorizationDecision ? { authorizationDecision: input.binding.authorizationDecision } : {}),
    commitSha: appended.commitSha?.sha ?? null,
    cut: appended.cut,
  };
}

function mintKindId(): string {
  return `KND-${randomBytes(16).toString("hex")}`;
}

function candidate(
  action: RepoTaskAction,
  current: VerticalDeclarationDocumentV1 | null,
  occurredAt: string,
  acceptedRevision: number,
  mint: () => string,
): {
  readonly type: "vertical_declared" | "vertical_kind_upserted" | "vertical_kind_retired";
  readonly definition: ReturnType<typeof decodeVerticalDefinition>;
  readonly kindId: string | null;
  readonly kindRef: string | null;
  readonly kindVersion: number | null;
  readonly reason: string | null;
} {
  if (action.kind === "vertical-declaration-migrate") {
    const seed = JSON.parse(readFileSync(path.join(defaultAssets, "vertical.json"), "utf8"));
    return {
      type: "vertical_declared",
      definition: decodeVerticalDefinition(seed),
      kindId: null,
      kindRef: null,
      kindVersion: null,
      reason: null,
    };
  }
  if (!current) reject("vertical_declaration_required", "Run ha migrate vertical-declaration before changing kinds.");
  const kindId = typeof action.kindId === "string" ? action.kindId.trim() : "";
  const retire = action.kind === "vertical-kind-retire",
    reason = retire && typeof action.reason === "string" ? action.reason.trim() : "",
    command: VerticalKindCommandResult = applyVerticalKindCommand({
      definition: current.definition,
      acceptedRevision,
      expectedVersion: Number(action.expectedVersion),
      kind: retire ? "retire" : action.kind === "vertical-kind-publish-schema" ? "publish-schema" : "upsert",
      kindId,
      mintedKindId: mint(),
      ...(retire ? { retiredAt: occurredAt, reason } : {}),
      ...(action.kind === "vertical-kind-upsert" ? { declaration: action.declaration } : {}),
      ...(action.kind === "vertical-kind-publish-schema" ? { attributes: action.attributes } : {}),
    });
  return {
    type: retire ? "vertical_kind_retired" : "vertical_kind_upserted",
    definition: command.definition,
    kindId,
    kindRef: command.kindRef,
    kindVersion: command.kindVersion,
    reason: retire ? reason : null,
  };
}
