import { readDaemonRegistry, registerDaemonRepo, unregisterDaemonRepo, type ActorIdentity, type WriteReceipt, type WriteSource } from "../../kernel/src/index.ts";
import { bootstrapRepo, type RepoBootstrapInput } from "./repo-bootstrap.ts";
import { loadPeopleRoster } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { openRepoCell, type RepoCell, type RepoCellStatus, type RepoTaskAction } from "./repo-cell.ts";

export interface DaemonHost {
  readonly run: (repoId: string, action: RepoTaskAction, auth: DaemonAuthenticationContext) => Promise<WriteReceipt>;
  readonly bootstrap: (request: RepoBootstrapInput, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  readonly admin: (request: { readonly kind: "register"; readonly rootDir: string; readonly repoId: string } | { readonly kind: "unregister"; readonly repoId: string }) => Promise<Record<string, unknown>>;
  readonly status: () => { readonly daemonId: string; readonly pid: number; readonly repos: readonly RepoCellStatus[] };
  readonly close: () => Promise<void>;
}

export async function openDaemonHost(input: { readonly daemonId: string; readonly userRoot: string }): Promise<DaemonHost> {
  const cells = new Map<string, RepoCell>();
  const unavailable = new Map<string, RepoCellStatus>();
  const repos = readDaemonRegistry({ userRoot: input.userRoot }).repos.filter((repo) => repo.state === "enabled");
  await Promise.all(repos.map(async (repo) => {
    try { cells.set(repo.repoId, await openRepoCell({ repoId: repo.repoId, rootDir: repo.canonicalRoot, ownerId: input.daemonId })); }
    catch (error) { consumeKnownError(error); unavailable.set(repo.repoId, { repoId: repo.repoId, rootDir: repo.canonicalRoot, state: "unavailable", generation: 0,
      queueDepth: 0, recoveryMs: 0, lastError: hostErrorMessage(error) }); }
  }));
  const attach = async (rootDir: string, repoId: string) => { const registered = registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot: input.userRoot, createConvenienceLinks: false });
    if (!cells.has(repoId)) { try { cells.set(repoId, await openRepoCell({ repoId, rootDir: registered.repo.canonicalRoot, ownerId: input.daemonId })); unavailable.delete(repoId); }
      catch (error) { consumeKnownError(error); unavailable.set(repoId, { repoId, rootDir: registered.repo.canonicalRoot, state: "unavailable", generation: 0, queueDepth: 0, recoveryMs: 0, lastError: hostErrorMessage(error) }); } } return registered; };
  return {
    bootstrap: async (request, auth) => {
      const rootDir = bootstrapRepo(request, auth);
      const registered = await attach(rootDir, request.repoId);
      return { schema: "command-receipt/v2", ok: true, command: "init", outcome: "applied", repoId: registered.repo.repoId,
        rootDir, changed: registered.changed, nextAction: "Create a task through the resident daemon." };
    },
    admin: async (request) => { if (request.kind === "register") { const result = await attach(request.rootDir, request.repoId); return { schema: "command-receipt/v2", ok: true, command: "daemon-repo-register", outcome: "applied", repo: result.repo, changed: result.changed }; }
      const result = unregisterDaemonRepo(request.repoId, { userRoot: input.userRoot, createConvenienceLinks: false }); await cells.get(request.repoId)?.close(); cells.delete(request.repoId); unavailable.delete(request.repoId);
      return { schema: "command-receipt/v2", ok: true, command: "daemon-repo-unregister", outcome: "applied", repo: result.repo, changed: result.changed }; },
    run: async (repoId, action, auth) => {
      const cell = cells.get(repoId);
      if (!cell) return reject(action, unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown",
        unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`);
      const spoof = ["actor", "root", "canonicalRoot", "source", "workspaceId", "expectedRevision", "eventId", "occurredAt"]
        .find((field) => Object.hasOwn(action, field));
      if (spoof) return reject(action, "ingress_binding_forbidden", `Payload cannot report ${spoof}; daemon binds actor, root, source, revision, and time.`);
      try { return await cell.run(action, await binding(cell.status().rootDir, auth)); }
      catch (error) { return reject(action, code(error), hostErrorMessage(error)); }
    },
    status: () => ({ daemonId: input.daemonId, pid: process.pid,
      repos: [...cells.values()].map((cell) => cell.status()).concat([...unavailable.values()]).sort((a, b) => a.repoId.localeCompare(b.repoId)) }),
    close: async () => { await Promise.all([...cells.values()].map((cell) => cell.close())); }
  };
}

async function binding(rootDir: string, auth: DaemonAuthenticationContext): Promise<{ readonly actor: ActorIdentity; readonly source: WriteSource; readonly roles?: readonly string[] }> {
  if (auth.assignmentBinding) return { actor: auth.assignmentBinding.actor,
    source: { kind: "assignment", nodeId: auth.assignmentBinding.nodeId, assignmentId: auth.assignmentBinding.assignmentId } };
  const roster = loadPeopleRoster({ rootDir });
  const resolved = await makeTransportDerivedIdentityProvider(roster).resolveActor({ authContext: auth,
    command: { method: "repo.task.run", namespace: "repo", requiresRepo: true } });
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  if (!resolved.actor.roles.some((role) => roster.roleAllows(role, "repo-write") || roster.roleAllows(role, "repo-read"))) {
    throw hostCodedError("rbac_forbidden", `Principal ${resolved.actor.personId} has no repo role.`);
  }
  return { actor: { principal: { personId: resolved.actor.personId }, executor: null },
    roles: [...resolved.actor.roles, ...(resolved.actor.roles.some((role) => roster.roleAllows(role, "arbiter")) ? ["$arbiter"] : [])],
    source: "local" };
}
function reject(action: RepoTaskAction, errorCode: string, nextAction: string): WriteReceipt { return { outcome: "rejected", opId: `rejected:${action.kind}`,
  code: errorCode, origin: "daemon", evidence: `rejection:${errorCode}`, nextAction }; }
function hostCodedError(errorCode: string, text: string): Error { const error = new Error(text) as Error & { code: string }; error.code = errorCode; return error; }
function code(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "daemon_error"; }
function hostErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function consumeKnownError(error: unknown): void { void error; }
