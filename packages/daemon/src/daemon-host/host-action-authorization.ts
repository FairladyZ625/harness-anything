import { composeDurableActionEnvelope } from "@harness-anything/application/internal/durable-action-envelope";
import {
  actionDeclarations,
  documentPath,
  parseEntityRef,
  resolveWorkspaceDocumentPath,
  type AuthorizationDecision,
  type AuthorizationResource,
  type EntityRef,
} from "@harness-anything/kernel";
import { localDefaultBinding, localSystemActionBinding } from "./daemon-host-binding.ts";
import {
  evaluateOnlinePersonAction,
  onlineAuthorizationCredential,
  type TaskAncestorAuthorizationMetadata,
} from "./repo-cell-authorization.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface TaskReadAuthorizationTarget {
  readonly taskId?: string;
  readonly taskIds?: readonly string[];
  readonly documentPath?: string;
  readonly documentPaths?: readonly string[];
  readonly pathCoordinate?: "workspace";
  readonly opaqueDenial?: boolean;
}

export async function requireAuthorizedHostAction(
  input: Parameters<typeof evaluateFleetAction>[0],
): Promise<AuthorizationDecision> {
  const decision = await evaluateFleetAction(input);
  if (decision.outcome === "denied")
    throw Object.assign(new Error(decision.nextActions.join(" ") || "Access denied."), {
      code: "authorization_denied",
      authorizationDecision: decision,
    });
  return decision;
}

/**
 * A host-level action answers to the acting person's grant on the fleet, on the one
 * repository it reaches when the caller names it, or on a specific entity (plus its Work ancestors)
 * for task-level selective disclosure.
 */
export async function evaluateFleetAction(input: {
  readonly kind: string;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly repoId?: string;
  readonly entityRef?: EntityRef;
  readonly readTask?: (
    taskId: string,
  ) => TaskAncestorAuthorizationMetadata | null | Promise<TaskAncestorAuthorizationMetadata | null>;
  readonly opaqueDenial?: boolean;
  readonly fetchPort?: typeof fetch;
}): Promise<AuthorizationDecision> {
  const target: EntityRef = input.entityRef ?? "settings/repository",
    envelope = composeDurableActionEnvelope({
      actionId: input.actionId,
      kind: input.kind,
      target,
      actor: input.binding.actor,
      authorizationRef: input.binding.authorizationDecision?.policyRef ?? "authorization-provider@1",
    }),
    credential = onlineAuthorizationCredential({ binding: input.binding });
  const finalizeDecision = (decision: AuthorizationDecision): AuthorizationDecision => {
    if (decision.outcome !== "denied" || input.opaqueDenial !== true) return decision;
    return Object.freeze({
      ...decision,
      subject: "settings/repository",
      nextActions: Object.freeze(["Access denied."]),
    });
  };
  if (!credential) {
    const declaration = actionDeclarations.find((candidate) => candidate.kind === input.kind);
    // dec_2446BC2F8C68630F71AE3E3BD7/CH4 reclassified daemon controls as host-local, but the
    // declaration records that the acting person's session is still required: only the one-time
    // rbac-bootstrap exception keeps socket-owner authority. A host-local label must not widen
    // who may purge, bootstrap, or control a repository.
    if (
      input.binding.source === "local" &&
      input.binding.daemonSocketOwner === true &&
      declaration &&
      declaration.residency.scope !== "canonical" &&
      declaration.socketOwnerAuthority !== false
    ) {
      return Object.freeze({
        policyRef: "daemon-socket-owner@1",
        actor: envelope.actor,
        subject: envelope.target,
        bindingsUsed: Object.freeze([{ proof: "unix-socket-owner-boundary", scope: input.kind }]),
        outcome: "allowed" as const,
        reasonCodes: Object.freeze(["daemon_socket_owner"]),
        nextActions: Object.freeze([]),
        evaluatedAtCut: input.evaluatedAtCut,
      });
    }
    return Object.freeze({
      policyRef: envelope.authorizationRef,
      actor: envelope.actor,
      subject: input.opaqueDenial === true ? "settings/repository" : envelope.target,
      bindingsUsed: Object.freeze([{ authority: "authorization-provider", scope: input.kind }]),
      outcome: "denied" as const,
      reasonCodes: Object.freeze(["authentication_required"]),
      nextActions: Object.freeze([
        input.opaqueDenial === true
          ? "Access denied."
          : "Sign in with the configured authorization provider and request an applicable policy group.",
      ]),
      evaluatedAtCut: input.evaluatedAtCut,
    });
  }
  const resource: AuthorizationResource =
    input.repoId === undefined
      ? { kind: "fleet" }
      : input.entityRef === undefined
        ? { kind: "repository", repoId: input.repoId }
        : { kind: "entity", repoId: input.repoId, entityRef: input.entityRef };
  const decision = await evaluateOnlinePersonAction({
    credential,
    binding: input.binding,
    envelope,
    action: input.kind,
    resource,
    evaluatedAtCut: input.evaluatedAtCut,
    ...(input.readTask === undefined ? {} : { readTask: input.readTask }),
    ...(input.fetchPort === undefined ? {} : { fetchPort: input.fetchPort }),
  });
  return finalizeDecision(decision);
}

/** Single-point task target extractor for action-backed reads (doc-show, task-read-set, task-show, etc.). */
export function resolveTaskReadTargetFromAction(
  action: Readonly<Record<string, unknown>>,
): TaskReadAuthorizationTarget | null {
  const kind = typeof action.kind === "string" ? action.kind : "";
  const pathCoordinate = action.pathCoordinate === "workspace" ? ("workspace" as const) : undefined;
  if (
    kind === "task-show" ||
    kind === "task-read-set" ||
    kind === "task-delivery-certificate" ||
    kind === "task-review"
  ) {
    const taskId = nonEmptyString(action.taskId);
    return taskId === null ? null : { taskId };
  }
  if (kind === "doc-show") {
    const docPath = nonEmptyString(action.path);
    return docPath === null
      ? null
      : { documentPath: docPath, ...(pathCoordinate === undefined ? {} : { pathCoordinate }), opaqueDenial: true };
  }
  if (kind === "doc-status" || kind === "doc-dry-run") {
    const paths = Array.isArray(action.paths) ? action.paths : [];
    const taskId = nonEmptyString(action.taskId);
    if (taskId !== null && paths.length === 0) return { taskId };
    if (paths.length > 0) {
      const documentPaths = paths.map(nonEmptyString);
      if (documentPaths.every((value): value is string => value !== null))
        return {
          ...(taskId === null ? {} : { taskId }),
          documentPaths,
          ...(pathCoordinate === undefined ? {} : { pathCoordinate }),
          opaqueDenial: true,
        };
    }
  }
  return null;
}

/** Single-point task target extractor for RPC/Fleet read methods (raw artifacts, documents, context, dispatches). */
export function resolveTaskReadTargetFromMethod(
  method: string,
  payload: Readonly<Record<string, unknown>>,
): TaskReadAuthorizationTarget | null {
  if (method === "repo.task.read") {
    const action = payload.action;
    return action && typeof action === "object" && !Array.isArray(action)
      ? resolveTaskReadTargetFromAction(action as Readonly<Record<string, unknown>>)
      : null;
  }
  if (
    method === "repo.tasks.document.read" ||
    method === "repo.tasks.documents.list" ||
    method === "repo.tasks.runtimeContext.read" ||
    method === "repo.tasks.completion.read" ||
    method === "repo.tasks.deliveryDiff.read" ||
    method === "repo.task.show"
  ) {
    const taskId = nonEmptyString(payload.taskId);
    return taskId === null ? null : { taskId };
  }
  if (method === "repo.work.topology.read") {
    const workRootTaskId = nonEmptyString(payload.workRootTaskId);
    return workRootTaskId === null ? null : { taskId: workRootTaskId };
  }
  if (method === "repo.workspace.scope.read") {
    const rootTaskId = nonEmptyString(payload.rootTaskId);
    return rootTaskId === null ? null : { taskId: rootTaskId };
  }
  if (method === "repo.task.dispatches") {
    const taskId = nonEmptyString(payload.taskId);
    if (taskId !== null) return { taskId };
    if (Array.isArray(payload.taskIds) && payload.taskIds.length > 0) {
      const taskIds = payload.taskIds.map(nonEmptyString);
      if (taskIds.every((value): value is string => value !== null)) return { taskIds };
    }
  }
  return null;
}

export async function resolveTaskReadAuthorizationScopes(
  cell: Pick<RepoCell, "taskIdForDocumentPath"> & { readonly status?: () => { readonly rootDir: string } },
  target: TaskReadAuthorizationTarget | null | undefined,
  signal?: AbortSignal,
): Promise<readonly (EntityRef | undefined)[]> {
  if (!target) return [undefined];
  const scopes: (EntityRef | undefined)[] = [];
  const seen = new Set<string | undefined>();
  const addScope = (scope: EntityRef | undefined) => {
    if (seen.has(scope)) return;
    seen.add(scope);
    scopes.push(scope);
  };
  const taskIds = [...(target.taskId === undefined ? [] : [target.taskId]), ...(target.taskIds ?? [])];
  for (const taskId of taskIds) {
    const candidate = `task/${taskId}`;
    addScope(parseEntityRef(candidate) === null ? undefined : (candidate as EntityRef));
  }
  const documentPaths = [
    ...(target.documentPath === undefined ? [] : [target.documentPath]),
    ...(target.documentPaths ?? []),
  ];
  const rootDir = target.pathCoordinate === "workspace" ? cell.status?.().rootDir : undefined;
  for (const rawPath of documentPaths) {
    let authoredPath = rawPath;
    if (target.pathCoordinate === "workspace") {
      if (rootDir === undefined) {
        addScope(undefined);
        continue;
      }
      const resolved = resolveWorkspaceDocumentPath(rootDir, rawPath);
      if (!resolved.ok) {
        addScope(undefined);
        continue;
      }
      authoredPath = resolved.documentPath;
    }
    const taskId = cell.taskIdForDocumentPath
      ? await cell.taskIdForDocumentPath(documentPath(authoredPath), signal)
      : null;
    if (taskId === null) {
      addScope(undefined);
      continue;
    }
    const candidate = `task/${taskId}`;
    addScope(parseEntityRef(candidate) === null ? undefined : (candidate as EntityRef));
  }
  return scopes.length === 0 ? [undefined] : scopes;
}

export function makeOpaqueTaskAncestorReader(
  cell: Pick<RepoCell, "readTaskAuthorizationMetadata">,
  signal?: AbortSignal,
): ((taskId: string) => Promise<TaskAncestorAuthorizationMetadata | null>) | undefined {
  if (typeof cell.readTaskAuthorizationMetadata !== "function") return undefined;
  const readMetadata = cell.readTaskAuthorizationMetadata.bind(cell);
  return async (taskId) => {
    const [row] = await readMetadata([taskId], signal);
    return row === undefined ? null : { taskClass: row.taskClass, metadata: { parentTaskId: row.parentTaskId } };
  };
}

/**
 * Single cross-cutting selective-disclosure gate for task-scoped repository reads.
 * Evaluates entity visibility (with Work ancestor inheritance) before any content or existence read.
 */
export async function authorizeTaskScopedRepositoryRead(input: {
  readonly kind: string;
  readonly repoId: string;
  readonly cell: Pick<RepoCell, "readTaskAuthorizationMetadata" | "taskIdForDocumentPath"> & {
    readonly status?: () => { readonly rootDir: string };
  };
  readonly binding: RepoCellBinding;
  readonly target: TaskReadAuthorizationTarget | null;
  readonly signal?: AbortSignal;
}): Promise<AuthorizationDecision> {
  const scopes = await resolveTaskReadAuthorizationScopes(input.cell, input.target, input.signal),
    readTask = makeOpaqueTaskAncestorReader(input.cell, input.signal),
    authorize = (entityRef?: EntityRef) =>
      requireAuthorizedHostAction({
        kind: input.kind,
        repoId: input.repoId,
        ...(entityRef === undefined ? {} : { entityRef }),
        ...(entityRef === undefined || readTask === undefined ? {} : { readTask }),
        ...(input.target?.opaqueDenial === true ? { opaqueDenial: true } : {}),
        binding: input.binding,
        actionId:
          entityRef === undefined ? `${input.kind}:${input.repoId}` : `${input.kind}:${input.repoId}:${entityRef}`,
        evaluatedAtCut: `repository:${input.repoId}:current`,
      });
  let decision: AuthorizationDecision | undefined;
  for (const entityRef of scopes) {
    decision = await authorize(entityRef);
    if (decision.outcome === "denied") return decision;
  }
  return decision!;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Host-level authority: the daemon's socket owner locally, anyone else through the fleet grant. */
export async function requireAuthorizedFleetAction(input: {
  readonly kind: string;
  readonly userRoot: string;
  readonly auth: DaemonAuthenticationContext;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly now?: string;
  readonly fetchPort?: typeof fetch;
}): Promise<AuthorizationDecision> {
  const binding = await localSystemActionBinding(input.userRoot, input.kind, input.auth, () =>
    Promise.resolve(localDefaultBinding(input.auth)),
  );
  return requireAuthorizedHostAction({ ...input, binding });
}
