import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  applyVerticalKindCommand,
  compileVerticalDeclarationEvent,
  decodeVerticalDefinition,
  parseVerticalDeclarationDocument,
  type CanonicalEventStore,
  type TaskProjection,
  type VerticalKindCommandResult,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { noChanges, reject } from "./entity-action-write-helpers.ts";

export async function runVerticalDeclarationAction(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  /** Opaque kind identity is minted at the application boundary; the domain only validates its shape. */
  readonly mintKindId?: () => string;
}): Promise<WriteReceiptDraft> {
  const target = path.join(input.rootDir, "harness", "vertical.json"),
    current = existsSync(target) ? parseVerticalDeclarationDocument(JSON.parse(readFileSync(target, "utf8"))) : null;
  if (input.action.kind === "vertical-declaration-migrate" && current)
    return noChanges({
      opId: `vertical-declaration-existing-${current.revision}`,
      revision: current.revision,
      evidence: JSON.stringify({ schema: "vertical-declaration-result/v1", idempotent: true }),
    });
  const nextRevision = (input.store.readHead()?.revision ?? 0) + 1,
    occurredAt = input.now(),
    result = candidate(input.action, current, occurredAt, input.mintKindId ?? mintKindId);
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
  current: ReturnType<typeof parseVerticalDeclarationDocument> | null,
  occurredAt: string,
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
      revision: current.revision,
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
