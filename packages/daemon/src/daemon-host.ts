import { readDaemonRegistry, registerDaemonRepo, unregisterDaemonRepo, type ActorIdentity, type WriteReceipt, type WriteSource } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId, type DaemonGuiReadMethod, type DaemonGuiReadResultMap } from "./protocol/daemon-protocol.contract.ts";
import { resolveRepoBootstrap, type RepoBootstrapRequest } from "./repo-bootstrap.ts";
import { loadPeopleRoster } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import type { DaemonCommandClass } from "./identity/types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { openRepoCell, type RepoCell, type RepoCellStatus, type RepoTaskAction } from "./repo-cell.ts";

export interface DaemonHost {
  readonly run: (repoId: string, action: RepoTaskAction, auth: DaemonAuthenticationContext) => Promise<WriteReceipt>;
  readonly read: (repoId: string, method: DaemonGuiReadMethod, auth: DaemonAuthenticationContext) => Promise<DaemonGuiReadResultMap[DaemonGuiReadMethod]>;
  readonly bootstrap: (request: RepoBootstrapRequest, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  readonly admin: (request: { readonly kind: "register"; readonly rootDir: string; readonly repoId: string } | { readonly kind: "unregister"; readonly repoId: string }, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  readonly status: () => { readonly daemonId: string; readonly pid: number; readonly repos: readonly RepoCellStatus[] };
  readonly close: () => Promise<void>;
}

export async function openDaemonHost(input: { readonly daemonId: string; readonly userRoot: string }): Promise<DaemonHost> {
  const cells = new Map<string, RepoCell>();
  const unavailable = new Map<string, RepoCellStatus>();
  const repos = readDaemonRegistry({ userRoot: input.userRoot }).repos.filter((repo) => repo.state === "enabled");
  await Promise.all(repos.map(async (repo) => {
    try { cells.set(repo.repoId, await openRepoCell({ repoId: workspaceId(repo.repoId), rootDir: canonicalRoot(repo.canonicalRoot), ownerId: input.daemonId })); }
    catch (error) { unavailable.set(repo.repoId, { repoId: repo.repoId, rootDir: repo.canonicalRoot, state: "unavailable", generation: 0,
      queueDepth: 0, recoveryMs: 0, lastError: consumeKnownError(error) }); }
  }));
  const attach = async (rootDir: string, repoId: string) => { const root = canonicalRoot(rootDir), id = workspaceId(repoId);
    const registered = registerDaemonRepo({ canonicalRoot: root, repoId, userRoot: input.userRoot, createConvenienceLinks: false });
    if (!cells.has(repoId)) try { cells.set(repoId, await openRepoCell({ repoId: id, rootDir: root, ownerId: input.daemonId })); unavailable.delete(repoId); }
    catch (error) { unavailable.set(repoId, { repoId, rootDir: root, state: "unavailable", generation: 0, queueDepth: 0, recoveryMs: 0, lastError: consumeKnownError(error) }); }
    return registered; };
  return {
    bootstrap: async (request, auth) => {
      const prepared = resolveRepoBootstrap(request), cell = await openRepoCell({ repoId: prepared.repoId, rootDir: prepared.rootDir,
        ownerId: input.daemonId, bootstrap: { input: prepared, auth } });
      let registered; try { registered = registerDaemonRepo({ canonicalRoot: prepared.rootDir, repoId: prepared.repoId, userRoot: input.userRoot, createConvenienceLinks: false }); cells.set(prepared.repoId, cell); unavailable.delete(prepared.repoId); }
      catch (error) { await cell.close(); throw error; }
      return { schema: "command-receipt/v2", ok: true, command: "init", outcome: "applied", repoId: registered.repo.repoId,
        rootDir: prepared.rootDir, changed: registered.changed, nextAction: "Create a task through the resident daemon." };
    },
    admin: async (request, auth) => { const rootDir = request.kind === "register" ? request.rootDir : readDaemonRegistry({ userRoot: input.userRoot }).repos.find((repo) => repo.repoId === request.repoId)?.canonicalRoot;
      if (!rootDir) throw hostCodedError("repo_namespace_unknown", `Unknown repo namespace: ${request.repoId}.`); await binding(rootDir, auth, "admin");
      if (request.kind === "register") { const result = await attach(request.rootDir, request.repoId); return { schema: "command-receipt/v2", ok: true, command: "daemon-repo-register", outcome: "applied", repo: result.repo, changed: result.changed }; }
      const result = unregisterDaemonRepo(request.repoId, { userRoot: input.userRoot, createConvenienceLinks: false }); await cells.get(request.repoId)?.close(); cells.delete(request.repoId); unavailable.delete(request.repoId);
      return { schema: "command-receipt/v2", ok: true, command: "daemon-repo-unregister", outcome: "applied", repo: result.repo, changed: result.changed }; },
    run: async (repoId, action, auth) => {
      const cell = cells.get(repoId);
      if (!cell) return reject(action, unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown",
        unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`);
      const spoof = ["actor", "root", "canonicalRoot", "source", "workspaceId", "expectedRevision", "eventId", "occurredAt"]
        .find((field) => Object.hasOwn(action, field));
      if (spoof) return reject(action, "ingress_binding_forbidden", `Payload cannot report ${spoof}; daemon binds actor, root, source, revision, and time.`);
      try { return await cell.run(action, await binding(cell.status().rootDir, auth, actionCapability(action.kind))); }
      catch (error) { return reject(action, code(error), consumeKnownError(error)); }
    },
    read: async (repoId, method, auth) => { const cell = cells.get(repoId);
      if (!cell) throw hostCodedError(unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown", unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`);
      await binding(cell.status().rootDir, auth, "repo-read"); return cell.read(method); },
    status: () => ({ daemonId: input.daemonId, pid: process.pid,
      repos: [...cells.values()].map((cell) => cell.status()).concat([...unavailable.values()]).sort((a, b) => a.repoId.localeCompare(b.repoId)) }),
    close: async () => { await Promise.all([...cells.values()].map((cell) => cell.close())); }
  };
}

async function binding(rootDir: string, auth: DaemonAuthenticationContext, required: DaemonCommandClass): Promise<{ readonly actor: ActorIdentity; readonly source: WriteSource; readonly roles?: readonly string[] }> {
  if (auth.assignmentBinding) { if (required === "admin" || required === "arbiter") throw hostCodedError("rbac_forbidden", `Assignment ingress cannot perform ${required}.`); return { actor: auth.assignmentBinding.actor,
    source: { kind: "assignment", nodeId: auth.assignmentBinding.nodeId, assignmentId: auth.assignmentBinding.assignmentId } }; }
  const roster = loadPeopleRoster({ rootDir });
  const resolved = await makeTransportDerivedIdentityProvider(roster).resolveActor({ authContext: auth,
    command: required === "admin" ? { method: "daemon.repo.admin", namespace: "admin", requiresRepo: true } : { method: "repo.task.run", namespace: "repo", requiresRepo: true } });
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  if (!resolved.actor.roles.some((role) => roster.roleAllows(role, required))) {
    throw hostCodedError("rbac_forbidden", `Principal ${resolved.actor.personId} lacks ${required}.`);
  }
  return { actor: { principal: { personId: resolved.actor.personId }, executor: null },
    roles: [...resolved.actor.roles, ...(resolved.actor.roles.some((role) => roster.roleAllows(role, "arbiter")) ? ["$arbiter"] : [])],
    source: "local" };
}
function actionCapability(kind: string): DaemonCommandClass { if (kind === "task-show" || kind === "receipt-show") return "repo-read"; return kind === "task-review-execution" ? "arbiter" : "repo-write"; }
function reject(action: RepoTaskAction, errorCode: string, nextAction: string): WriteReceipt { return { outcome: "rejected", opId: `rejected:${action.kind}`,
  code: errorCode, origin: "daemon", evidence: `rejection:${errorCode}`, nextAction }; }
function hostCodedError(errorCode: string, text: string): Error { const error = new Error(text) as Error & { code: string }; error.code = errorCode; return error; }
function code(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "daemon_error"; }
function consumeKnownError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
