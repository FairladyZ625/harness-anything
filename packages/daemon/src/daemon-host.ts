import { readDaemonRegistry, registerDaemonRepo, resolveHarnessLayout, unregisterDaemonRepo, type WriteReceipt } from "../../kernel/src/index.ts";
import { canonicalRoot, commandClassForAction, workspaceId, type DaemonGuiReadMethod, type DaemonGuiReadResultMap } from "./protocol/daemon-protocol.contract.ts"; import { compileRepoRepositoryScaffold, compileRepoTaskPackage, presetUserRoot, recoverPresetRunStatus } from "../../preset/src/index.ts";
import { resolveRepoBootstrap, type RepoBootstrapReceipt, type RepoBootstrapRequest } from "./repo-bootstrap.ts";
import { loadPeopleRoster } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import type { DaemonCommandClass } from "./identity/types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { openRepoCell, type RepoCell, type RepoCellBinding, type RepoCellStatus, type RepoTaskAction } from "./repo-cell.ts";
import { openDocSyncWatcher, type DocSyncWatcher } from "./doc-sync-watcher.ts";
import type { AgentRuntimeAttachEvent, AgentRuntimeAttachSubscription, AgentRuntimeNativeSignal, AgentRuntimeWitnessBinding, AgentRuntimeWitnessToken } from "./agent-runtime-stream.ts";
export interface DaemonHost {
  readonly run: (repoId: string, action: RepoTaskAction, auth: DaemonAuthenticationContext) => Promise<WriteReceipt>; readonly presetRun: (repoId: string, action: RepoTaskAction, auth: DaemonAuthenticationContext) => ReturnType<RepoCell["presetRun"]>;
  readonly replica: (repoId: string) => RepoCell["replica"];
  readonly read: <M extends DaemonGuiReadMethod>(repoId: string, method: M, payload: Readonly<Record<string, unknown>>, auth: DaemonAuthenticationContext) => Promise<DaemonGuiReadResultMap[M]>;
  readonly attach: (repoId: string, runtimeSessionId: string, afterCursor: string, auth: DaemonAuthenticationContext) => Promise<AgentRuntimeAttachSubscription>;
  readonly issueRuntimeWitness: (repoId: string, runtimeSessionId: string, auth: DaemonAuthenticationContext) => Promise<AgentRuntimeWitnessToken>; readonly bindRuntimeWitness: (repoId: string, token: string) => AgentRuntimeWitnessBinding; readonly publishRuntimeWitness: (repoId: string, token: string, signal: AgentRuntimeNativeSignal) => AgentRuntimeAttachEvent;
  readonly bootstrap: (request: RepoBootstrapRequest, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  readonly admin: (request: { readonly kind: "register"; readonly rootDir: string; readonly repoId: string } | { readonly kind: "unregister"; readonly repoId: string }, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  readonly status: () => { readonly daemonId: string; readonly pid: number; readonly repos: readonly RepoCellStatus[] };
  readonly close: () => Promise<void>;
}
export async function openDaemonHost(input: { readonly daemonId: string; readonly userRoot: string; readonly watchOwnerUid?: number; readonly watchDebounceMs?: number }): Promise<DaemonHost> {
  const cells = new Map<string, RepoCell>(), watchers = new Map<string, DocSyncWatcher>(), watchFailures = new Map<string, string>(), ownerUid = input.watchOwnerUid ?? process.getuid?.() ?? 0;
  const unavailable = new Map<string, RepoCellStatus>();
  const repos = readDaemonRegistry({ userRoot: input.userRoot }).repos.filter((repo) => repo.state === "enabled");
  await Promise.all(repos.map(async (repo) => {
    try { const cell = await openRepoCell({ repoId: workspaceId(repo.repoId), rootDir: canonicalRoot(repo.canonicalRoot), ownerId: input.daemonId, authoredBranch: repo.authoredBranch }); cells.set(repo.repoId, cell); await startWatch(repo.repoId, cell); }
    catch (error) { unavailable.set(repo.repoId, { repoId: repo.repoId, rootDir: repo.canonicalRoot, state: "unavailable", generation: 0,
      queueDepth: 0, recoveryMs: 0, lastError: consumeKnownError(error) }); }
  }));
  const attach = async (rootDir: string, repoId: string) => { const root = canonicalRoot(rootDir), id = workspaceId(repoId);
    const registered = registerDaemonRepo({ canonicalRoot: root, repoId, userRoot: input.userRoot, createConvenienceLinks: false });
    if (!cells.has(repoId)) try { const cell = await openRepoCell({ repoId: id, rootDir: root, ownerId: input.daemonId, authoredBranch: registered.repo.authoredBranch }); cells.set(repoId, cell); await startWatch(repoId, cell); unavailable.delete(repoId); }
    catch (error) { unavailable.set(repoId, { repoId, rootDir: root, state: "unavailable", generation: 0, queueDepth: 0, recoveryMs: 0, lastError: consumeKnownError(error) }); }
    return registered; };
  return {
    bootstrap: async (request, auth) => {
      const prepared = resolveRepoBootstrap(request, auth); await watchers.get(prepared.repoId)?.close(); watchers.delete(prepared.repoId); watchFailures.delete(prepared.repoId); await cells.get(prepared.repoId)?.close(); cells.delete(prepared.repoId); unavailable.delete(prepared.repoId); let published: RepoBootstrapReceipt | undefined, cell: RepoCell; try { cell = await openRepoCell({ repoId: prepared.repoId, rootDir: prepared.rootDir,
        ownerId: input.daemonId, bootstrap: prepared, onBootstrap: (receipt) => { published = receipt; } }); } catch (error) { if (!published?.publication.ok) throw error; return failedConfigureVerify(published, prepared.repoId, prepared.rootDir, false, error, [], "daemon-l2-readiness"); }
      let registered; try { registered = registerDaemonRepo({ canonicalRoot: prepared.rootDir, repoId: prepared.repoId, userRoot: input.userRoot, createConvenienceLinks: false }); cells.set(prepared.repoId, cell); await startWatch(prepared.repoId, cell); unavailable.delete(prepared.repoId); }
      catch (error) { await cell.close(); throw error; }
      const receipt = cell.bootstrapReceipt!; if (!receipt.publication.ok) return { schema: "command-receipt/v2", ok: false, command: "init", repoId: registered.repo.repoId, rootDir: prepared.rootDir, registryChanged: registered.changed, ...receipt };
      const steps = ["publication-readback"]; try { const layout = resolveHarnessLayout(prepared.rootDir), reparsed = compileRepoRepositoryScaffold(prepared.rootDir), expected = new Map(prepared.repositoryPlan.documents.map((document) => [document.slot, document.path])); if (reparsed.documents.length !== expected.size || reparsed.documents.some((document) => expected.get(document.slot) !== document.path || document.disposition === "created")) throw hostCodedError("configure_verify_layout", "Canonical repository slots did not resolve to the published paths."); steps.push("canonical-layout"); const readiness = await cell.verifyReadiness(); steps.push("daemon-l2-readiness"); const smoke = compileRepoTaskPackage({ rootDir: prepared.rootDir, taskId: "configure-verify-smoke", action: { kind: "task-create", title: "Configure Verify" } }); steps.push("task-bootstrap-dry-run"); return { schema: "command-receipt/v2", ok: true, command: "init", repoId: registered.repo.repoId, rootDir: prepared.rootDir, registryChanged: registered.changed, ...receipt, configureVerify: { ok: true, steps, roots: { contextRoot: layout.contextRoot, governanceRoot: layout.governanceRoot, standardsRoot: layout.standardsRoot, adrRoot: layout.adrRoot, milestonesRoot: layout.milestonesRoot }, requiredSlots: reparsed.documents.map(({ slot, path: target }) => ({ slot, path: target })), l2: readiness, compiledDocuments: smoke.documents.length } }; }
      catch (error) { return failedConfigureVerify(receipt, registered.repo.repoId, prepared.rootDir, registered.changed, error, steps); }
    },
    admin: async (request, auth) => { const rootDir = request.kind === "register" ? request.rootDir : readDaemonRegistry({ userRoot: input.userRoot }).repos.find((repo) => repo.repoId === request.repoId)?.canonicalRoot;
      if (!rootDir) throw hostCodedError("repo_namespace_unknown", `Unknown repo namespace: ${request.repoId}.`); await binding(rootDir, auth, "admin");
      if (request.kind === "register") { const result = await attach(request.rootDir, request.repoId); return { schema: "command-receipt/v2", ok: true, command: "daemon-repo-register", outcome: "applied", repo: result.repo, changed: result.changed }; }
      const result = unregisterDaemonRepo(request.repoId, { userRoot: input.userRoot, createConvenienceLinks: false }); await watchers.get(request.repoId)?.close(); watchers.delete(request.repoId); watchFailures.delete(request.repoId); await cells.get(request.repoId)?.close(); cells.delete(request.repoId); unavailable.delete(request.repoId);
      return { schema: "command-receipt/v2", ok: true, command: "daemon-repo-unregister", outcome: "applied", repo: result.repo, changed: result.changed }; },
    run: async (repoId, action, auth) => {
      const cell = cells.get(repoId);
      if (!cell) return reject(action, unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown",
        unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`);
      const spoof = ["actor", "root", "canonicalRoot", "source", "workspaceId", "expectedRevision", "eventId", "occurredAt", "gitCredential", "credential"]
        .find((field) => Object.hasOwn(action, field));
      if (spoof) return reject(action, "ingress_binding_forbidden", `Payload cannot report ${spoof}; daemon binds actor, root, source, revision, and time.`);
      try { return await cell.run(action, await binding(cell.status().rootDir, auth, commandClassForAction(action.kind), action.kind === "doc-submit")); }
      catch (error) { return reject(action, code(error), consumeKnownError(error)); }
    },
    replica: (repoId) => requiredCell(cells, unavailable, repoId).replica,
    presetRun: async (repoId, action, auth) => { const cell = cells.get(repoId), missing = unavailable.get(repoId), recoveryRunId = recoverableRunId(action); if (!cell) { if (missing && recoveryRunId) try { await binding(missing.rootDir, auth, commandClassForAction(action.kind)); return recoverPresetRunStatus({ rootDir: missing.rootDir, userRoot: presetUserRoot(missing.rootDir) }, recoveryRunId); } catch (error) { return rejectPresetRun(recoveryRunId, code(error), consumeKnownError(error)); } return rejectPresetRun("run_invalid", missing ? "repo_unavailable" : "repo_namespace_unknown", missing?.lastError ?? `Unknown repo namespace: ${repoId}.`); } try { return await cell.presetRun(action, await binding(cell.status().rootDir, auth, commandClassForAction(action.kind))); } catch (error) { return rejectPresetRun(typeof action.runId === "string" ? action.runId : "run_invalid", code(error), consumeKnownError(error)); } },
    read: async (repoId, method, payload, auth) => { const cell = cells.get(repoId);
      if (!cell) throw hostCodedError(unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown", unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`);
      await binding(cell.status().rootDir, auth, "repo-read"); return cell.read(method, payload); },
    attach: async (repoId, runtimeSessionId, afterCursor, auth) => { const cell = requiredCell(cells, unavailable, repoId); await binding(cell.status().rootDir, auth, "repo-read"); return cell.attach(runtimeSessionId, afterCursor); },
    issueRuntimeWitness: async (repoId, runtimeSessionId, auth) => { const cell = requiredCell(cells, unavailable, repoId), serverBinding = await binding(cell.status().rootDir, auth, "repo-write"); if (serverBinding.roles?.some((role) => role === "$admin" || role === "$arbiter")) throw hostCodedError("rbac_forbidden", "Admin and arbiter identities cannot become runtime witnesses."); return cell.runtime.issueWitnessToken(runtimeSessionId, { principalId: serverBinding.actor.principal.personId, source: serverBinding.source }); }, bindRuntimeWitness: (repoId, token) => requiredCell(cells, unavailable, repoId).runtime.bindWitness(token), publishRuntimeWitness: (repoId, token, signal) => { const cell = requiredCell(cells, unavailable, repoId), witness = cell.runtime.bindWitness(token); return cell.runtime.publish(witness.runtimeSessionId, signal); },
    status: () => ({ daemonId: input.daemonId, pid: process.pid,
      repos: [...[...cells.entries()].map(([repoId, cell]) => ({ ...cell.status(), docSync: watchers.get(repoId)?.status() ?? { state: "blocked", nextAction: watchFailures.get(repoId) ?? "register the Unix socket owner in the repository prose writer role" } })), ...unavailable.values()].sort((a, b) => a.repoId.localeCompare(b.repoId)) }),
    close: async () => { await Promise.all([...watchers.values()].map((watcher) => watcher.close())); await Promise.all([...cells.values()].map((cell) => cell.close())); }
  };
  async function startWatch(repoId: string, cell: RepoCell): Promise<void> { try { const base = await binding(cell.status().rootDir, { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } }, "repo-write", true); watchers.set(repoId, openDocSyncWatcher({ rootDir: cell.status().rootDir, personId: base.actor.principal.personId, debounceMs: input.watchDebounceMs, run: (action, attribution) => cell.run(action, attribution ? { ...base, source: { kind: "watch_session", sessionId: attribution.sessionId, path: attribution.path, fingerprint: attribution.fingerprint } } : base) })); watchFailures.delete(repoId); } catch (error) { consumeKnownError(error); watchFailures.set(repoId, error instanceof Error ? error.message : String(error)); } }
}
async function binding(rootDir: string, auth: DaemonAuthenticationContext, required: DaemonCommandClass, returnDeniedDocDetail = false): Promise<RepoCellBinding> {
  if (auth.assignmentBinding) { if (required === "admin" || required === "arbiter") throw hostCodedError("rbac_forbidden", `Assignment ingress cannot perform ${required}.`); return { actor: auth.assignmentBinding.actor,
    source: { kind: "assignment", nodeId: auth.assignmentBinding.nodeId, assignmentId: auth.assignmentBinding.assignmentId }, docWriteAllowed: true, assignmentScope: { repoId: auth.assignmentBinding.repoId, taskId: auth.assignmentBinding.taskId, executionId: auth.assignmentBinding.executionId, paths: auth.assignmentBinding.paths } }; }
  const roster = loadPeopleRoster({ rootDir });
  const resolved = await makeTransportDerivedIdentityProvider(roster).resolveActor({ authContext: auth,
    command: required === "admin" ? { method: "daemon.repo.admin", namespace: "admin", requiresRepo: true } : { method: "repo.task.run", namespace: "repo", requiresRepo: true } });
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  const allowed = resolved.actor.roles.some((role) => roster.roleAllows(role, required)); if (!allowed && !returnDeniedDocDetail) {
    throw hostCodedError("rbac_forbidden", `Principal ${resolved.actor.personId} lacks ${required}.`);
  }
  return { actor: { principal: { personId: resolved.actor.personId }, executor: null },
    roles: [...resolved.actor.roles, ...(resolved.actor.roles.some((role) => roster.roleAllows(role, "arbiter")) ? ["$arbiter"] : []), ...(resolved.actor.roles.some((role) => roster.roleAllows(role, "admin")) ? ["$admin"] : [])],
    source: "local", docWriteAllowed: allowed };
}
function reject(action: RepoTaskAction, errorCode: string, nextAction: string): WriteReceipt { return { outcome: "rejected", opId: `rejected:${action.kind}`,
  code: errorCode, origin: "daemon", evidence: `rejection:${errorCode}`, nextAction }; } function rejectPresetRun(runId: string, code: string, nextAction: string) { return { schema: "preset-run-receipt/v1" as const, runId, outcome: "rejected" as const, phase: "rejected" as const, phases: ["rejected"] as const, code, nextAction }; }
function hostCodedError(errorCode: string, text: string): Error { const error = new Error(text) as Error & { code: string }; error.code = errorCode; return error; } function recoverableRunId(action: RepoTaskAction): string | undefined { return action.kind === "preset-run-status" && typeof action.runId === "string" ? action.runId : undefined; }
function code(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "daemon_error"; }
function consumeKnownError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function failedConfigureVerify(receipt: RepoBootstrapReceipt, repoId: string, rootDir: string, registryChanged: boolean, error: unknown, steps: readonly string[], failedAt = ["publication-readback", "canonical-layout", "daemon-l2-readiness", "task-bootstrap-dry-run"].find((step) => !steps.includes(step))) { const hint = `init Configure-Verify smoke failed: ${consumeKnownError(error)}`, next = `${receipt.next} # Repair the reported config or scaffold error, then rerun init.`; return { schema: "command-receipt/v2", ok: false, command: "init", repoId, rootDir, registryChanged, ...receipt, outcome: "partial", summary: hint, next, code: "configure_verify_failed", error: { code: "configure_verify_failed", hint }, nextAction: next, configureVerify: { ok: false, steps, failedAt, causeCode: code(error) } }; }
function requiredCell(cells: Map<string, RepoCell>, unavailable: Map<string, RepoCellStatus>, repoId: string): RepoCell { const cell = cells.get(repoId); if (!cell) throw hostCodedError(unavailable.has(repoId) ? "repo_unavailable" : "repo_namespace_unknown", unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`); return cell; }
