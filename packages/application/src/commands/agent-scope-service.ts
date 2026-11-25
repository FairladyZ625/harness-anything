import { createHash } from "node:crypto";
import {
  agentDeclarationContentDigest,
  attributeEntityActionCriterion,
  judgeUnshareCompensation,
  localDeclarationMatchesSharedValue,
  resolveAgentScope,
  type AgentDeclarationV1,
  type AuthorizationDecision,
  type LocalAgentRecordV1,
  type LocalAgentStorePort,
  type LocalAgentTransferIntent,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { CommandAction } from "./command-ports.ts";

export interface AgentScopeSharedState {
  readonly value: Readonly<Record<string, unknown>>;
  readonly revision: number;
}

export interface AgentScopeInstallPorts {
  readonly localStore: LocalAgentStorePort;
  readonly shared: AgentScopeSharedState | null;
  readonly compileDeclaration: (declaration: AgentDeclarationV1) => void;
  readonly appliedCutWatermark: () => number;
  readonly installSharedAgent: (input: {
    readonly declaration: AgentDeclarationV1;
    readonly expectedVersion: number;
    readonly opId: string;
  }) => WriteReceipt | Promise<WriteReceipt>;
  readonly authorizeSharedDelete?: (input: {
    readonly agentId: string;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly opId: string;
  }) => Promise<AuthorizationDecision>;
  readonly deleteSharedAgent: (input: {
    readonly agentId: string;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly opId: string;
    readonly authorizationDecision?: AuthorizationDecision;
  }) => WriteReceipt | Promise<WriteReceipt>;
}

export interface AgentScopeInstallRequest {
  readonly action: CommandAction;
  readonly declaration: AgentDeclarationV1;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly report?: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly string[];
}

export interface AgentScopeDeleteRequest {
  readonly agentId: string;
  readonly reason: string;
  readonly expectedVersion: unknown;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision;
}

function scopeError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function dryRunLocalPreview(request: AgentScopeInstallRequest, revision: number): WriteReceipt {
  const report = request.report ?? {
    schema: "agent-install-report/v1",
    entityId: request.declaration.id,
    mode: "dry-run",
    changed: true,
    issues: [],
  };
  return {
    outcome: "pending",
    opId: `preview:${createHash("sha256").update(request.opId).digest("hex")}`,
    revision,
    evidence: JSON.stringify({
      report: { ...report, mode: "dry-run" },
      event: {
        schema: "local-agent-record/v1",
        entityKind: "agent",
        entityId: request.declaration.id,
        scope: resolveAgentScope(request.declaration.scope),
      },
      dryRun: true,
    }),
    effects: [],
    updatedProjection: null,
    authorizationDecision: request.authorizationDecision,
    ...(request.warnings && request.warnings.length > 0 ? { warnings: request.warnings } : {}),
  };
}

function hostLocalAppliedReceipt(input: {
  readonly opId: string;
  readonly revision: number;
  readonly appliedCut: number;
  readonly evidence: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly warnings?: readonly string[];
}): WriteReceipt {
  return {
    outcome: "applied",
    effects: [],
    opId: input.opId,
    revision: input.revision,
    expectedVersion: input.revision,
    updatedProjection: null,
    evidence: input.evidence,
    proof: {
      committedRevision: input.revision,
      appliedCut: input.appliedCut,
      durable: true,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    authorizationDecision: input.authorizationDecision,
    ...(input.warnings && input.warnings.length > 0 ? { warnings: input.warnings } : {}),
  };
}

/**
 * Orchestrates Agent scope persistence and cross-authority transfers (`local` CRUD,
 * `local -> shared` publish, and `shared -> local` unshare) using injected ports.
 * Returns `null` when the install is a pure shared canonical write with no local counterpart.
 */
export async function executeAgentScopeInstall(
  ports: AgentScopeInstallPorts,
  request: AgentScopeInstallRequest,
): Promise<WriteReceipt | null> {
  const declaration = request.declaration,
    targetScope = resolveAgentScope(declaration.scope),
    localRecord = ports.localStore.get(declaration.id),
    shared = ports.shared;

  if (targetScope === "shared" && localRecord === null) return null;

  // Schema and instructions readiness run before any dry-run preview or local write (F-DRY).
  ports.compileDeclaration(declaration);

  if (localRecord !== null && shared !== null) {
    const matches = localDeclarationMatchesSharedValue(
      localRecord.declaration,
      shared.value,
      localRecord.pendingTransfer,
    );
    if (!matches)
      throw scopeError("agent_scope_conflict", `Agent ${declaration.id} exists in both local and shared scope.`);
  }

  const expectedVersion = request.action.expectedVersion;
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0))
    throw scopeError("invalid_command", "expectedVersion must be a non-negative integer when supplied.");

  if (request.action.dryRun === true) {
    const previewRevision =
      targetScope === "local"
        ? shared !== null
          ? shared.revision
          : (localRecord?.revision ?? 0)
        : (localRecord?.revision ?? 0);
    if (expectedVersion !== undefined && Number(expectedVersion) !== previewRevision)
      throw attributeEntityActionCriterion(
        scopeError(
          "revision_conflict",
          `agent ${declaration.id} expected revision ${String(expectedVersion)}, current revision is ${String(previewRevision)}.`,
        ),
        "install",
        "agent/entity-revision",
      );
    return dryRunLocalPreview(request, previewRevision);
  }

  // Case 1: Pure local create/update (no shared counterpart).
  if (targetScope === "local" && shared === null) {
    const currentRevision = localRecord?.revision ?? 0;
    if (expectedVersion !== undefined && Number(expectedVersion) !== currentRevision)
      throw attributeEntityActionCriterion(
        scopeError(
          "revision_conflict",
          `agent ${declaration.id} expected revision ${String(expectedVersion)}, current revision is ${String(currentRevision)}.`,
        ),
        "install",
        "agent/entity-revision",
      );
    const revision = ports.localStore.write(declaration, {
      expectedVersion: currentRevision,
      pendingTransfer: null,
    });
    return hostLocalAppliedReceipt({
      opId: request.opId,
      revision,
      appliedCut: ports.appliedCutWatermark(),
      evidence: JSON.stringify(request.action.preparedEntityAction ?? { entityId: declaration.id }),
      authorizationDecision: request.authorizationDecision,
      warnings: request.warnings,
    });
  }

  // Case 2: Shared -> Local (`unshare`): authorize agent-delete explicitly, stage local intent,
  // delete shared through canonical writer, and only compensate when delete is proven uncommitted.
  if (targetScope === "local" && shared !== null) {
    if (expectedVersion !== undefined && Number(expectedVersion) !== shared.revision)
      throw attributeEntityActionCriterion(
        scopeError(
          "revision_conflict",
          `agent ${declaration.id} expected revision ${String(expectedVersion)}, current revision is ${String(shared.revision)}.`,
        ),
        "install",
        "agent/entity-revision",
      );
    const reason = "Agent returned to local scope.",
      deleteOpId = `agent-unshare-${request.opId}`;
    let deleteAuthDecision: AuthorizationDecision | undefined;
    if (ports.authorizeSharedDelete) {
      deleteAuthDecision = await ports.authorizeSharedDelete({
        agentId: declaration.id,
        reason,
        expectedVersion: shared.revision,
        opId: deleteOpId,
      });
      if (deleteAuthDecision.outcome !== "allowed")
        return {
          outcome: "op_rejected",
          opId: deleteOpId,
          code: "authorization_denied",
          effects: [],
          updatedProjection: null,
          authorizationDecision: deleteAuthDecision,
          rejectionExplanation: `Policy ${deleteAuthDecision.policyRef} denied agent-delete: ${deleteAuthDecision.reasonCodes.join(", ")}.`,
        };
    }

    const intent: LocalAgentTransferIntent = {
      direction: "unshare",
      operationId: deleteOpId,
      sourceRevision: shared.revision,
      targetScope: "local",
      declarationSha256: agentDeclarationContentDigest(declaration),
    };
    const localRevision = ports.localStore.write(declaration, {
      expectedVersion: localRecord?.revision ?? 0,
      pendingTransfer: intent,
      preserveRevision: localRecord !== null,
    });

    const restoreStagedLocal = () => {
      if (localRecord === null) {
        ports.localStore.remove(declaration.id);
      } else {
        ports.localStore.write(localRecord.declaration, {
          expectedVersion: localRevision,
          pendingTransfer: localRecord.pendingTransfer ?? null,
          preserveRevision: true,
        });
      }
    };

    let deleteReceipt: WriteReceipt;
    try {
      deleteReceipt = await ports.deleteSharedAgent({
        agentId: declaration.id,
        reason,
        expectedVersion: shared.revision,
        opId: deleteOpId,
        ...(deleteAuthDecision ? { authorizationDecision: deleteAuthDecision } : {}),
      });
    } catch (error) {
      const judgment = judgeUnshareCompensation({ error });
      if (judgment === "compensate_remove_local") restoreStagedLocal();
      throw error;
    }

    const judgment = judgeUnshareCompensation({
      outcome: deleteReceipt.outcome,
      durable: deleteReceipt.proof?.durable,
    });
    if (judgment === "commit_complete") {
      ports.localStore.write(declaration, {
        expectedVersion: localRevision,
        pendingTransfer: null,
        preserveRevision: true,
      });
      return hostLocalAppliedReceipt({
        opId: request.opId,
        revision: localRevision,
        appliedCut: ports.appliedCutWatermark(),
        evidence: JSON.stringify(request.action.preparedEntityAction ?? { entityId: declaration.id }),
        authorizationDecision:
          deleteReceipt.authorizationDecision ?? deleteAuthDecision ?? request.authorizationDecision,
        warnings: request.warnings,
      });
    }
    if (judgment === "compensate_remove_local") {
      restoreStagedLocal();
      return deleteReceipt;
    }
    // Uncertain / durable-pending outcome: keep local copy with pendingTransfer so retry converges
    // and the user never loses their only live Agent declaration (F-UNSHARE).
    return {
      outcome: "pending",
      opId: request.opId,
      code: "agent_unshare_pending",
      revision: localRevision,
      expectedVersion: localRevision,
      effects: deleteReceipt.effects ?? [],
      updatedProjection: null,
      evidence: JSON.stringify({
        entityId: declaration.id,
        deleteOpId,
        deleteOutcome: deleteReceipt.outcome,
        localRetained: true,
      }),
      proof: {
        committedRevision: localRevision,
        appliedCut: ports.appliedCutWatermark(),
        durable: true,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      authorizationDecision: deleteReceipt.authorizationDecision ?? deleteAuthDecision ?? request.authorizationDecision,
      warnings: [
        ...(request.warnings ?? []),
        `Shared deletion (${deleteOpId}) is not yet confirmed applied; local copy is retained. Retry unshare to converge.`,
      ],
    };
  }

  // Case 3: Local -> Shared (`share` / publish): keep local revision fence separate from center CAS.
  const sourceLocal = localRecord as LocalAgentRecordV1;
  if (expectedVersion !== undefined && Number(expectedVersion) !== sourceLocal.revision)
    throw attributeEntityActionCriterion(
      scopeError(
        "revision_conflict",
        `Local Agent ${declaration.id} expected revision ${String(expectedVersion)}, current revision is ${String(sourceLocal.revision)}.`,
      ),
      "install",
      "agent/entity-revision",
    );

  const centerExpectedVersion = shared === null ? 0 : shared.revision,
    shareIntent: LocalAgentTransferIntent = {
      direction: "share",
      operationId: request.opId,
      sourceRevision: sourceLocal.revision,
      targetScope: "shared",
      declarationSha256: agentDeclarationContentDigest(declaration),
    };
  // Stage pendingTransfer with the target declaration's digest (covers edited GUI drafts on retry)
  // while keeping the local declaration & revision intact until center confirms durability.
  ports.localStore.write(sourceLocal.declaration, {
    expectedVersion: sourceLocal.revision,
    pendingTransfer: shareIntent,
    preserveRevision: true,
  });

  const sharedReceipt = await ports.installSharedAgent({
    declaration,
    expectedVersion: centerExpectedVersion,
    opId: request.opId,
  });

  if (sharedReceipt.outcome === "applied" || sharedReceipt.proof?.durable === true) {
    ports.localStore.remove(declaration.id);
    return sharedReceipt;
  }
  if (sharedReceipt.outcome === "op_rejected") {
    ports.localStore.write(sourceLocal.declaration, {
      expectedVersion: sourceLocal.revision,
      pendingTransfer: null,
      preserveRevision: true,
    });
  }
  return sharedReceipt;
}

/**
 * Deletes a node-local Agent declaration when no shared counterpart exists (F-LOCAL-CRUD).
 * Returns `null` when the Agent is shared (or absent from local scope) so canonical delete runs.
 */
export function executeAgentScopeDelete(
  ports: {
    readonly localStore: LocalAgentStorePort;
    readonly hasShared: boolean;
    readonly appliedCutWatermark: () => number;
  },
  request: AgentScopeDeleteRequest,
): WriteReceipt | null {
  const localRecord = ports.localStore.get(request.agentId);
  if (localRecord === null || ports.hasShared) return null;
  if (!Number.isSafeInteger(request.expectedVersion) || Number(request.expectedVersion) < 1)
    throw scopeError("invalid_command", "expectedVersion must be a positive Entity revision for deletion.");
  if (!request.reason.trim()) throw scopeError("invalid_command", "reason is required.");
  if (localRecord.revision !== Number(request.expectedVersion))
    throw attributeEntityActionCriterion(
      scopeError(
        "revision_conflict",
        `agent ${request.agentId} expected revision ${String(request.expectedVersion)}, current revision is ${String(localRecord.revision)}.`,
      ),
      "delete",
      "agent/entity-revision",
    );
  ports.localStore.remove(request.agentId, { expectedVersion: localRecord.revision });
  return hostLocalAppliedReceipt({
    opId: request.opId,
    revision: localRecord.revision,
    appliedCut: ports.appliedCutWatermark(),
    evidence: JSON.stringify({
      schema: "agent-delete-report/v1",
      entityId: request.agentId,
      scope: "local",
      reason: request.reason,
    }),
    authorizationDecision: request.authorizationDecision,
  });
}

/**
 * Catalog executor adapter: keeps entity-action-catalog-executor thin and within complexity bounds
 * while delegating local CRUD and cross-authority transfers to `executeAgentScopeInstall`.
 */
export function runCatalogAgentScopeInstall(input: {
  readonly localStore: LocalAgentStorePort | undefined;
  readonly preparedAction: CommandAction;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly sharedRowValue: Readonly<Record<string, unknown>> | undefined;
  readonly report: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  readonly appliedCutWatermark: () => number;
  readonly compileDeclaration: (declaration: AgentDeclarationV1) => void;
  readonly installSharedAgent: (input: {
    readonly declaration: AgentDeclarationV1;
    readonly expectedVersion: number;
    readonly opId: string;
  }) => WriteReceipt | Promise<WriteReceipt>;
  readonly authorizeSharedDelete?: (input: {
    readonly agentId: string;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly opId: string;
  }) => Promise<AuthorizationDecision>;
  readonly prepareSharedDelete: (action: CommandAction, opId: string) => CommandAction;
  readonly runSharedDelete: (
    action: CommandAction,
    opId: string,
    authorizationDecision?: AuthorizationDecision,
  ) => WriteReceipt | Promise<WriteReceipt>;
}): Promise<WriteReceipt | null> | null {
  const declaration = input.preparedAction.declaration as AgentDeclarationV1 | undefined;
  if (!declaration) return null;
  const hasLocal = input.localStore !== undefined && input.localStore.get(declaration.id) !== null;
  if (declaration.scope !== "local" && !hasLocal) return null;
  if (!input.localStore)
    throw scopeError("local_agent_store_unavailable", "The daemon user root is required for local Agents.");
  const sharedRevision =
      typeof input.preparedAction.sharedAgentRevision === "number" ? input.preparedAction.sharedAgentRevision : null,
    sharedValue =
      (input.preparedAction.sharedAgentValue as Readonly<Record<string, unknown>> | undefined) ?? input.sharedRowValue;
  return executeAgentScopeInstall(
    {
      localStore: input.localStore,
      shared: sharedRevision !== null && sharedValue ? { value: sharedValue, revision: sharedRevision } : null,
      compileDeclaration: input.compileDeclaration,
      appliedCutWatermark: input.appliedCutWatermark,
      installSharedAgent: input.installSharedAgent,
      ...(input.authorizeSharedDelete ? { authorizeSharedDelete: input.authorizeSharedDelete } : {}),
      deleteSharedAgent: ({ agentId, reason, expectedVersion, opId, authorizationDecision }) => {
        const delAction: CommandAction = { kind: "agent-delete", agentId, reason, expectedVersion };
        let preparedDelete: CommandAction;
        try {
          preparedDelete = input.prepareSharedDelete(delAction, opId);
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
              ? error.code
              : "operation_rejected";
          return {
            outcome: "op_rejected",
            opId,
            code,
            effects: [],
            updatedProjection: null,
            ...(authorizationDecision ? { authorizationDecision } : {}),
            rejectionExplanation: error instanceof Error ? error.message : String(error),
          };
        }
        return input.runSharedDelete(preparedDelete, opId, authorizationDecision);
      },
    },
    {
      action: input.preparedAction,
      declaration,
      opId: input.opId,
      authorizationDecision: input.authorizationDecision,
      report: input.report,
      warnings: input.warnings,
    },
  );
}
