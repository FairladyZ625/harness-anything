import path from "node:path";
import {
  executeAgentScopeDelete,
  executeAgentScopeInstall,
  settleHostLocalReceipt,
} from "@harness-anything/application/commands";
import {
  getExecutableEntityAction,
  readDaemonRegistry,
  requestedAgentScopeFromAction,
  resolveAgentScope,
  type AgentDeclarationV1,
  type WriteReceipt,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { EntityStore } from "@harness-anything/storage";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import {
  declarationRevision,
  prepareAgentEntityInstall,
  readAgentEntityDeclarationSource,
  type AgentRuntimeInstanceView,
} from "./agent-entities.ts";
import { createLocalAgentStorePort } from "./local-agent-store.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { operationId } from "./repo-cell-proof.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

interface EdgeSharedAgentSnapshot {
  readonly id: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly watermark: number;
}

function readEdgeSharedAgent(input: {
  readonly userRoot: string;
  readonly rootDir: string;
  readonly repoId: string;
  readonly agentId: string;
  readonly principalId?: string;
}): EdgeSharedAgentSnapshot | null {
  const config = readFleetEdgeConfig(input.userRoot, input.repoId, input.rootDir);
  if (!config) return null;
  const viewRoot = path.isAbsolute(config.viewRoot) ? config.viewRoot : path.resolve(input.rootDir, config.viewRoot);
  if (locateFleetMirrorView(viewRoot, input.repoId, config.nodeId, { includeEntries: false }) === null) return null;
  return withEdgeReadModel(
    {
      viewRoot,
      repoId: input.repoId,
      nodeId: config.nodeId,
      principalId: input.principalId,
      includeEntries: false,
      ...(config.maxAgeMs === undefined ? {} : { maxAgeMs: config.maxAgeMs }),
      ...(config.maxLagRevisions === undefined ? {} : { maxLagRevisions: config.maxLagRevisions }),
    },
    (projection) => {
      const row = projection.getEntity("agent", input.agentId);
      if (row === null || row.freshness === "orphaned") return null;
      return {
        id: input.agentId,
        value: row.value,
        revision: declarationRevision(row),
        watermark: projection.readCut().watermark,
      };
    },
  );
}

function edgeSharedEntityStore(shared: EdgeSharedAgentSnapshot | null): EntityStore {
  return {
    get: (kind: string, id: string) =>
      kind === "agent" && shared !== null && shared.id === id
        ? {
            value: shared.value,
            workspaceRevision: shared.revision,
          }
        : null,
  } as unknown as EntityStore;
}

function edgeSharedProjection(shared: EdgeSharedAgentSnapshot | null) {
  return {
    getEntity: (kind: string, id: string) =>
      kind === "agent" && shared !== null && shared.id === id
        ? ({
            id,
            kind,
            value: shared.value,
            workspaceRevision: shared.revision,
            currentVersion: shared.revision,
            freshness: "current",
          } as never)
        : null,
  };
}

/**
 * Edge-side adapter for local Agent CRUD and cross-authority scope transfers (`share` / `unshare`).
 * Pure shared writes return `null` so the caller uses standard `via-center-forward`.
 */
export async function runEdgeAgentScopeAction(input: {
  readonly userRoot: string | undefined;
  readonly repoId: string;
  readonly action: RepoTaskAction;
  readonly auth: { readonly transportKind: string; readonly nodePrincipal?: unknown };
  readonly binding: (rootDir: string) => Promise<RepoCellBinding>;
  readonly runtimeInstances?: () => readonly AgentRuntimeInstanceView[];
  readonly now: () => string;
  readonly forwardToCenter: (nextAction: RepoTaskAction) => Promise<Record<string, unknown> | null>;
}): Promise<WriteReceiptDraft | null> {
  const { userRoot, repoId, action, auth } = input;
  if (
    (action.kind !== "agent-install" && action.kind !== "agent-delete") ||
    auth.transportKind !== "unix-socket" ||
    auth.nodePrincipal ||
    typeof userRoot !== "string" ||
    userRoot.length === 0
  )
    return null;
  const edgeEntry = readDaemonRegistry({ userRoot }).repos.find(
    (entry) => entry.repoId === repoId && entry.mode === "remote-edge" && entry.state === "enabled",
  );
  if (!edgeEntry?.canonicalRoot) return null;
  const rootDir = edgeEntry.canonicalRoot;

  const localStore = createLocalAgentStorePort(userRoot, repoId);

  if (action.kind === "agent-delete") {
    const agentId = typeof action.agentId === "string" ? action.agentId.trim() : "";
    if (!agentId || localStore.get(agentId) === null) return null;
    const binding = await input.binding(rootDir),
      shared = readEdgeSharedAgent({
        userRoot,
        rootDir,
        repoId,
        agentId,
        principalId: binding.actor.principal.personId,
      });
    if (shared !== null) return null;
    const opId = operationId(action, binding, repoId, 0),
      authorizationDecision = await evaluateRepoCellAction({
        action,
        binding,
        actionId: opId,
        repoId,
        revision: 0,
        now: input.now(),
      }),
      deleted = executeAgentScopeDelete(
        {
          localStore,
          hasShared: false,
          appliedCutWatermark: () => 0,
        },
        {
          agentId,
          reason: typeof action.reason === "string" ? action.reason : "",
          expectedVersion: action.expectedVersion,
          opId,
          authorizationDecision,
        },
      );
    return deleted ? settleHostLocalReceipt(action, deleted as WriteReceipt) : null;
  }

  let agentId: string;
  if (Object.hasOwn(action, "agentId")) {
    agentId = typeof action.agentId === "string" ? action.agentId.trim() : "";
    if (!agentId) return null;
    const hasLocal = localStore.get(agentId) !== null,
      requestedScope = requestedAgentScopeFromAction(action);
    if (!hasLocal && requestedScope !== "local") return null;
  } else {
    const decoded = readAgentEntityDeclarationSource(action),
      requestedScope = requestedAgentScopeFromAction(action);
    if ("issues" in decoded) {
      if (requestedScope !== "local") return null;
      throw Object.assign(new Error(decoded.issues[0]?.message ?? "Invalid Agent declaration."), {
        code: decoded.issues[0]?.code ?? "invalid_manifest",
      });
    }
    agentId = decoded.declaration.id;
    const hasLocal = localStore.get(agentId) !== null,
      targetScope = resolveAgentScope(decoded.declaration.scope);
    if (targetScope === "shared" && !hasLocal) return null;
  }

  const binding = await input.binding(rootDir),
    shared = readEdgeSharedAgent({
      userRoot,
      rootDir,
      repoId,
      agentId,
      principalId: binding.actor.principal.personId,
    }),
    prepared = prepareAgentEntityInstall({
      rootDir,
      action,
      entityStore: edgeSharedEntityStore(shared),
      projection: edgeSharedProjection(shared),
      runtimeInstances: input.runtimeInstances?.(),
      localAgent: (id) => localStore.get(id),
    }),
    declaration = prepared.declaration as AgentDeclarationV1,
    opId = operationId(action, binding, repoId, shared?.revision ?? 0),
    authorizationDecision = await evaluateRepoCellAction({
      action,
      binding,
      actionId: opId,
      repoId,
      revision: shared?.revision ?? 0,
      now: input.now(),
    }),
    installContract = getExecutableEntityAction("agent-install")!;

  const receipt = await executeAgentScopeInstall(
    {
      localStore,
      shared: shared ? { value: shared.value, revision: shared.revision } : null,
      compileDeclaration: (next) => {
        installContract.execution!.compile!({
          action: { ...action, declaration: next },
          actor: binding.actor,
          source: binding.source,
          session: { runtime: "edge-local-agent", sessionId: null, transcriptReachability: "unavailable" },
          opId,
          occurredAt: input.now(),
          workspaceRevision: (shared?.revision ?? 0) + 1,
        });
      },
      appliedCutWatermark: () => shared?.watermark ?? 0,
      installSharedAgent: async ({ declaration: next, expectedVersion, opId: shareOpId }) => {
        const forwarded = await input.forwardToCenter({
          kind: "agent-install",
          declaration: { ...next, scope: "shared" },
          expectedVersion,
          idempotencyKey: shareOpId,
        });
        if (!forwarded)
          throw Object.assign(new Error("The registered remote-edge configuration is unavailable."), {
            code: "fleet_edge_config_invalid",
          });
        return forwarded as unknown as WriteReceiptDraft;
      },
      deleteSharedAgent: async ({ agentId: id, reason, expectedVersion, opId: deleteOpId }) => {
        const forwarded = await input.forwardToCenter({
          kind: "agent-delete",
          agentId: id,
          reason,
          expectedVersion,
          idempotencyKey: deleteOpId,
        });
        if (!forwarded)
          throw Object.assign(new Error("The registered remote-edge configuration is unavailable."), {
            code: "fleet_edge_config_invalid",
          });
        return forwarded as unknown as WriteReceiptDraft;
      },
    },
    {
      action: { ...action, preparedEntityAction: { report: prepared.report } },
      declaration,
      opId,
      authorizationDecision,
      report: prepared.report,
      warnings: prepared.report.warnings?.map((warning) => warning.message),
    },
  );
  if (receipt === null) return null;
  return receipt.proof?.canonicalVisible === false || action.dryRun === true
    ? settleHostLocalReceipt(action, receipt as WriteReceipt)
    : receipt;
}
