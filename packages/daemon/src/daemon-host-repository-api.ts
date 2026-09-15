/** @daemon-transport-authority Daemon ingress filtering and repository dispatch. */
import { existsSync, realpathSync } from "node:fs";
import {
  readDaemonRegistry,
  getExecutableEntityAction,
  registerDaemonConnection,
  registerDaemonRepo,
  removeDaemonConnection,
  resolveHarnessLayout,
  unbindDaemonRepo,
  updateDaemonConnection,
  updateDaemonRepo,
} from "../../kernel/src/index.ts";
import {
  compileRepoRepositoryScaffold,
  compileRepoTaskPackage,
  presetUserRoot,
  recoverPresetRunStatus,
} from "../../preset/src/index.ts";
import { repoReadCommandTopology } from "../../preset/src/preset-command-contract.ts";
import type { DaemonHost } from "./daemon-host.ts";
import {
  canonicalRoot,
  commandDescriptorForAction,
  type DaemonGuiRpcReadMethod,
} from "./protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "./protocol/gui-result-validation.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";
import { resolveRepoBootstrap, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { openRepoCell, type RepoCell, type RepoCellReadMethod, type RepoTaskAction } from "./repo-cell.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { localDefaultBinding } from "./daemon-host-binding.ts";
import { requireAuthorizedHostAction } from "./host-action-authorization.ts";
import { entityActionCommandTopology } from "./repo-mode.ts";
import { resolveVerticalKindCommandAction } from "./vertical-kind-command-action.ts";
import { cachePurgePreservedPaths, purgeRepoCache } from "./repo-cache-purge.ts";
import { backupReceipt } from "./offline-storage.ts";
import {
  backupRepoForAllPurge,
  drillRepoAllPurgeBackup,
  removeRepoHarnessData,
  validateRepoAllPurge,
} from "./repo-all-purge.ts";

function isRepoCellReadMethod(method: DaemonGuiRpcReadMethod): method is RepoCellReadMethod {
  return (
    method !== "daemon.gui.system.read" &&
    method !== "daemon.gui.control.receipt" &&
    method !== "observe.tail" &&
    method !== "repo.workspace.summary.read" &&
    method !== "repo.gui.catalog.snapshot" &&
    method !== "repo.gui.catalog.preset.read" &&
    method !== "repo.terminal.sessions.list"
  );
}

export function createDaemonHostRepositoryApi(
  context: DaemonHostApiContext,
): Pick<DaemonHost, "bootstrap" | "admin" | "run" | "replica" | "settleMaterialization" | "presetRun" | "read"> {
  return {
    bootstrap: async (request, auth) => {
      const requestedRoot = canonicalRoot(request.rootDir, true),
        registeredRoot = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
          (repo) => repo.state === "enabled" && repo.mode === "local" && repo.canonicalRoot === requestedRoot,
        ),
        reusedRegistration = request.repoId === undefined && registeredRoot !== undefined;
      if (request.repoId !== undefined && registeredRoot && registeredRoot.repoId !== request.repoId)
        throw context.hostCodedError(
          "repository_already_registered",
          `This repository is already registered as ${registeredRoot.repoId}; ` +
            `rerun without --repo-id or with --repo-id ${registeredRoot.repoId}.`,
        );
      const registeredPersonId =
        reusedRegistration && request.personId === undefined
          ? (await context.binding(requestedRoot, auth)).actor.principal.personId
          : undefined;
      const prepared = resolveRepoBootstrap(
        reusedRegistration
          ? {
              ...request,
              repoId: registeredRoot.repoId,
              ...(registeredPersonId ? { personId: registeredPersonId } : {}),
            }
          : request,
        auth,
      );
      await context.waitForWarming(prepared.repoId);
      if (context.warming.has(prepared.repoId))
        throw context.hostCodedError("repo_warming", context.warmingMessage(prepared.repoId));
      await context.cells.get(prepared.repoId)?.close();
      context.cells.delete(prepared.repoId);
      context.unavailable.delete(prepared.repoId);
      let published: RepoBootstrapReceipt | undefined, cell: RepoCell;
      try {
        cell = await openRepoCell({
          repoId: prepared.repoId,
          rootDir: prepared.rootDir,
          mode: "local",
          ownerId: context.input.daemonId,
          defaultWriterEpochFence: context.writerEpochFence(prepared.repoId),
          runtimeDaemonRoute: context.runtimeDaemonRoute,
          bootstrap: prepared,
          onBootstrap: (receipt) => {
            published = receipt;
          },
          ...context.runtimePorts,
          ...(context.input.runtimeLaunch ? { runtimeLaunch: context.input.runtimeLaunch } : {}),
        });
      } catch (error) {
        if (!published?.publication.ok) throw error;
        return context.failedConfigureVerify(
          published,
          prepared.repoId,
          prepared.rootDir,
          false,
          error,
          [],
          "daemon-l2-readiness",
        );
      }
      let registered;
      try {
        registered = registerDaemonRepo({
          canonicalRoot: prepared.rootDir,
          repoId: prepared.repoId,
          mode: "local",
          userRoot: context.input.userRoot,
          createConvenienceLinks: false,
        });
        context.cells.set(prepared.repoId, cell);
        context.unavailable.delete(prepared.repoId);
        await context.scheduleScheduler.refresh();
      } catch (error) {
        await cell.close();
        throw error;
      }
      const receipt = cell.bootstrapReceipt!,
        reportedReceipt = reusedRegistration
          ? {
              ...receipt,
              summary: `This repository is already registered as ${prepared.repoId} and is initialized.`,
            }
          : receipt;
      if (!receipt.publication.ok)
        return {
          schema: "command-receipt/v2",
          ok: false,
          command: "init",
          repoId: registered.repo.repoId,
          rootDir: prepared.rootDir,
          registryChanged: registered.changed,
          ...reportedReceipt,
        };
      const steps = ["publication-readback"];
      try {
        const layout = resolveHarnessLayout(prepared.rootDir),
          settings = (await cell.read("repo.settings.read")).settings,
          reparsed = compileRepoRepositoryScaffold(prepared.rootDir, settings),
          expected = new Map(prepared.repositoryPlan.documents.map((document) => [document.slot, document.path]));
        if (
          reparsed.documents.length !== expected.size ||
          reparsed.documents.some(
            (document) => expected.get(document.slot) !== document.path || document.disposition === "created",
          )
        )
          throw context.hostCodedError(
            "configure_verify_layout",
            "Canonical repository slots did not resolve to the published paths.",
          );
        steps.push("canonical-layout");
        const readiness = await cell.verifyReadiness();
        steps.push("daemon-l2-readiness");
        const smoke = compileRepoTaskPackage({
          rootDir: prepared.rootDir,
          settings,
          taskId: "configure-verify-smoke",
          action: { kind: "task-create", title: "Configure Verify" },
        });
        steps.push("task-bootstrap-dry-run");
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "init",
          repoId: registered.repo.repoId,
          rootDir: prepared.rootDir,
          registryChanged: registered.changed,
          ...reportedReceipt,
          configureVerify: {
            ok: true,
            steps,
            roots: {
              contextRoot: layout.contextRoot,
              governanceRoot: layout.governanceRoot,
              standardsRoot: layout.standardsRoot,
              milestonesRoot: layout.milestonesRoot,
            },
            requiredSlots: reparsed.documents.map(({ slot, path: target }) => ({
              slot,
              path: target,
            })),
            l2: readiness,
            compiledDocuments: smoke.documents.length,
          },
        };
      } catch (error) {
        return context.failedConfigureVerify(
          receipt,
          registered.repo.repoId,
          prepared.rootDir,
          registered.changed,
          error,
          steps,
        );
      }
    },
    admin: async (request, auth) => {
      context.localOnly(auth);
      if (request.kind === "register") {
        const remoteProxy = request.mode === "remote-proxy",
          adminBinding = remoteProxy
            ? localDefaultBinding(auth)
            : await context.binding(context.requiredText(request.rootDir, "rootDir"), auth),
          authorizationDecision = requireAuthorizedHostAction({
            kind: "daemon-repo-register",
            binding: adminBinding,
            actionId: `daemon-repo-register:${request.repoId}`,
            evaluatedAtCut: "daemon-registry:current",
            now: context.now(),
          });
        const result = remoteProxy
          ? registerDaemonRepo({
              repoId: request.repoId,
              displayName: request.displayName,
              mode: "remote-proxy",
              connectionId: request.connectionId,
              endpoint: request.endpoint,
              userRoot: context.input.userRoot,
              createConvenienceLinks: false,
            })
          : await context.attach(request.rootDir!, request.repoId, request.mode);
        if (remoteProxy) await context.refreshRegistry();
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "daemon-repo-register",
          outcome: "applied",
          repo: result.repo,
          changed: result.changed,
          authorizationDecision,
          summary: [
            "repo register: repoId=",
            `${result.repo.repoId}`,
            " canonicalRoot=",
            `${result.repo.canonicalRoot ?? "none"}`,
            " mode=",
            `${result.repo.mode}`,
            " changed=",
            `${result.changed}`,
            "",
          ].join(""),
        };
      }
      if (request.kind === "update") {
        const existing = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
            (repo) => repo.repoId === request.repoId,
          ),
          adminBinding =
            existing?.canonicalRoot === null || existing === undefined
              ? localDefaultBinding(auth)
              : await context.binding(existing.canonicalRoot, auth),
          authorizationDecision = requireAuthorizedHostAction({
            kind: "daemon-repo-register",
            binding: adminBinding,
            actionId: `daemon-repo-update:${request.repoId}`,
            evaluatedAtCut: "daemon-registry:current",
            now: context.now(),
          }),
          result = updateDaemonRepo({
            ...request,
            userRoot: context.input.userRoot,
            createConvenienceLinks: false,
          });
        await context.refreshRegistry();
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "daemon-repo-update",
          outcome: "applied",
          repo: result.repo,
          changed: result.changed,
          authorizationDecision,
          summary: `repo update: repoId=${result.repo.repoId} changed=${result.changed}`,
        };
      }
      if (
        request.kind === "connection-register" ||
        request.kind === "connection-update" ||
        request.kind === "connection-unregister" ||
        request.kind === "connection-probe"
      ) {
        const removing = request.kind === "connection-unregister",
          connectionSubject = "connectionId" in request ? request.connectionId : request.endpoint,
          command =
            request.kind === "connection-register"
              ? "daemon-connection-add"
              : request.kind === "connection-update"
                ? "daemon-connection-update"
                : request.kind === "connection-unregister"
                  ? "daemon-connection-remove"
                  : "daemon-connection-probe",
          authorizationDecision = requireAuthorizedHostAction({
            kind: removing ? "repo-unbind" : "daemon-repo-register",
            binding: localDefaultBinding(auth),
            actionId: `${command}:${connectionSubject}`,
            evaluatedAtCut: "daemon-registry:current",
            now: context.now(),
          });
        if (request.kind === "connection-probe")
          return { ...(await context.remoteProxy.probe(request.endpoint)), command, authorizationDecision };
        const result =
          request.kind === "connection-register"
            ? registerDaemonConnection({
                id: request.connectionId,
                displayName: request.displayName,
                endpoint: request.endpoint,
                userRoot: context.input.userRoot,
              })
            : request.kind === "connection-update"
              ? updateDaemonConnection({
                  id: request.connectionId,
                  displayName: request.displayName,
                  endpoint: request.endpoint,
                  state: request.state,
                  userRoot: context.input.userRoot,
                })
              : removeDaemonConnection(request.connectionId, { userRoot: context.input.userRoot });
        return {
          schema: "command-receipt/v2",
          ok: true,
          command,
          outcome: "applied",
          connection: result.connection,
          changed: result.changed,
          authorizationDecision,
          summary: `connection ${request.kind}: connectionId=${result.connection.id} changed=${result.changed}`,
        };
      }
      const registry = readDaemonRegistry({ userRoot: context.input.userRoot }),
        known =
          registry.repos.some((repo) => repo.repoId === request.repoId) ||
          registry.invalidRepos.some((repo) => repo.repoId === request.repoId);
      if (!known) throw context.hostCodedError("repo_namespace_unknown", `Unknown repo namespace: ${request.repoId}.`);
      const registeredRepo = registry.repos.find((repo) => repo.repoId === request.repoId),
        invalidRepo = registry.invalidRepos.find((repo) => repo.repoId === request.repoId),
        purging = request.kind === "purge",
        purgingAll = purging && request.scope === "all";
      if (
        purging &&
        (!registeredRepo || registeredRepo.mode === "remote-proxy" || registeredRepo.canonicalRoot === null)
      )
        throw context.hostCodedError("repo_has_no_local_state", `Repository ${request.repoId} has no local state.`);
      if (
        purging &&
        (!existsSync(registeredRepo!.canonicalRoot!) ||
          realpathSync(registeredRepo!.canonicalRoot!) !== registeredRepo!.canonicalRoot)
      )
        throw context.hostCodedError(
          "repo_root_unavailable",
          `Repository ${request.repoId} canonical root is unavailable; no files were removed.`,
        );
      const rootDir = registeredRepo?.canonicalRoot ?? invalidRepo?.canonicalRoot ?? null,
        backupDir = purgingAll
          ? validateRepoAllPurge({
              rootDir: registeredRepo!.canonicalRoot!,
              repoId: request.repoId,
              backup: request.backup,
              confirm: request.confirm,
            })
          : null,
        adminBinding = registeredRepo?.canonicalRoot
          ? await context.binding(registeredRepo.canonicalRoot, auth)
          : localDefaultBinding(auth),
        authorizationDecision = requireAuthorizedHostAction({
          kind: purging ? "repo-purge" : "repo-unbind",
          binding: adminBinding,
          actionId: `${purging ? "repo-purge" : "repo-unbind"}:${request.repoId}`,
          evaluatedAtCut: "daemon-registry:current",
          now: context.now(),
        }),
        cell = context.cells.get(request.repoId),
        blockingWork = [
          ...(cell?.inFlightWork() ?? []),
          ...(context.fleetRoster?.assignments ?? []).flatMap((assignment) =>
            assignment.repoId !== request.repoId || cell
              ? []
              : [
                  {
                    kind: "fleet-assignment" as const,
                    id: assignment.assignmentId,
                    assignmentId: assignment.assignmentId,
                    nodeId: assignment.nodeId,
                    nextAction: `Release fleet assignment ${assignment.assignmentId} before retrying.`,
                  },
                ],
          ),
        ].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
      const inFlightSummary = `Repository ${request.repoId} still has ${blockingWork.length} in-flight item${blockingWork.length === 1 ? "" : "s"}; settle them before retrying.`;
      if (blockingWork.length > 0)
        return {
          schema: "command-receipt/v2",
          ok: false,
          command: purging ? "repo-purge" : "repo-unbind",
          outcome: "rejected",
          code: "repo_in_flight",
          repoId: request.repoId,
          blockingWork,
          next: blockingWork.map((item) => ({ command: item.nextAction, reason: `${item.kind} ${item.id}` })),
          rejectionExplanation: inFlightSummary,
          summary: inFlightSummary,
        };
      let backupManifest;
      if (purgingAll) {
        backupManifest = backupRepoForAllPurge({
          rootDir: rootDir!,
          backupDir: backupDir!,
          registration: registeredRepo!,
          writerEpoch: context.writerEpochHighWatermark(request.repoId),
        });
        drillRepoAllPurgeBackup({ rootDir: rootDir!, backupDir: backupDir!, manifest: backupManifest });
      }
      context.settleWarming(request.repoId);
      await context.closeCell(request.repoId);
      context.unavailable.delete(request.repoId);
      const result = unbindDaemonRepo(request.repoId, {
        userRoot: context.input.userRoot,
        createConvenienceLinks: false,
      });
      const repo = context.publicRegistryRepo(result.repo);
      if (purging) {
        const removed = purgingAll ? removeRepoHarnessData(rootDir!) : purgeRepoCache(rootDir!);
        if (purgingAll) context.retireWriterEpoch(request.repoId);
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "repo-purge",
          outcome: "applied",
          repoId: request.repoId,
          rootDir,
          scope: request.scope,
          registryChanged: result.changed,
          dataPreserved: !purgingAll,
          removed,
          preserved: purgingAll ? ["project files", ".git", ".worktrees"] : cachePurgePreservedPaths,
          ...(purgingAll
            ? {
                backup: backupReceipt(backupDir!, backupManifest!),
                restoreCommand: `ha restore ${JSON.stringify(backupDir)} --to <absolute-directory>`,
                rebindCommand: `ha init --repo-id ${request.repoId}`,
              }
            : { rebindCommand: "ha init" }),
          authorizationDecision,
          summary: purgingAll
            ? `Repository ${request.repoId} is backed up, restore-drilled, unbound, and its local Harness data was removed.`
            : `Repository ${request.repoId} is unbound and its derived cache state was removed; authoritative data was preserved.`,
        };
      }
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "repo-unbind",
        outcome: "applied",
        repoId: request.repoId,
        rootDir,
        registryChanged: result.changed,
        dataPreserved: true,
        rebindCommand: "ha init",
        authorizationDecision,
        summary: `Repository ${repo.repoId} is unbound. Data remains at ${String(rootDir)}; run ha init there to bind it again.`,
      };
    },
    run: async (repoId, action, auth) => {
      const command = entityActionCommandTopology(commandDescriptorForAction(action.kind), action),
        modeAdmission = context.admitHostMode(repoId, command, auth);
      if (!modeAdmission.ok) return context.rejectHostAction(action, modeAdmission.code, modeAdmission.nextAction);
      await context.attemptHostRecovery(repoId);
      const cell = context.cells.get(repoId);
      if (!cell)
        return context.rejectHostAction(
          action,
          context.warming.has(repoId)
            ? "repo_warming"
            : context.unavailable.has(repoId)
              ? "repo_unavailable"
              : "repo_namespace_unknown",
          context.warming.has(repoId)
            ? context.warmingMessage(repoId)
            : (context.unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`),
        );
      const spoof = [
        "actor",
        "root",
        "canonicalRoot",
        "workspaceId",
        "expectedRevision",
        "eventId",
        "occurredAt",
        "gitCredential",
        "credential",
      ].find((field) => Object.hasOwn(action, field));
      if (spoof)
        return context.rejectHostAction(
          action,
          "ingress_binding_forbidden",
          `Payload cannot report ${spoof}; daemon binds principal authority, root, revision, and time.`,
        );
      try {
        const serverBinding = await context.binding(
          cell.status().rootDir,
          auth,
          undefined,
          command.commandClass === "repo-read" ? undefined : repoId,
        );
        const resolvedAction = await resolveVerticalKindCommandAction(cell, action as RepoTaskAction),
          receipt = await cell.run(resolvedAction, serverBinding, auth.connectionSignal);
        if (getExecutableEntityAction(action.kind)?.target.kind === "schedule")
          await context.scheduleScheduler.refresh();
        return receipt;
      } catch (error) {
        return context.rejectHostAction(
          action,
          context.code(error),
          context.daemonErrorMessage(error),
          context.diagnosticForError(error),
        );
      }
    },
    replica: (repoId) => context.requiredCell(context.cells, context.warming, context.unavailable, repoId).replica,
    settleMaterialization: (repoId, settlementContext) =>
      context
        .requiredCell(context.cells, context.warming, context.unavailable, repoId)
        .settlePendingMaterialization(settlementContext),
    presetRun: async (repoId, action, auth) => {
      const command = commandDescriptorForAction(action.kind),
        hostAdmission = context.admitHostMode(repoId, command, auth);
      if (!hostAdmission.ok)
        return context.rejectPresetRun(
          typeof action.runId === "string" ? action.runId : "run_invalid",
          hostAdmission.code,
          hostAdmission.nextAction,
        );
      await context.attemptHostRecovery(repoId);
      const cell = context.cells.get(repoId),
        warmingUp = context.warming.get(repoId),
        missing = context.unavailable.get(repoId),
        recoveryRunId = context.recoverableRunId(action);
      try {
        const routed = action as RepoTaskAction;
        if (!cell) {
          if (missing && recoveryRunId) {
            await context.binding(missing.rootDir, auth);
            return recoverPresetRunStatus(
              {
                rootDir: missing.rootDir,
                userRoot: presetUserRoot(missing.rootDir),
              },
              recoveryRunId,
            );
          }
          return context.rejectPresetRun(
            "run_invalid",
            warmingUp ? "repo_warming" : missing ? "repo_unavailable" : "repo_namespace_unknown",
            warmingUp ? context.warmingMessage(repoId) : (missing?.lastError ?? `Unknown repo namespace: ${repoId}.`),
          );
        }
        const command = commandDescriptorForAction(routed.kind);
        return await cell.presetRun(
          routed,
          await context.binding(
            cell.status().rootDir,
            auth,
            undefined,
            command.commandClass === "repo-read" ? undefined : repoId,
          ),
        );
      } catch (error) {
        return context.rejectPresetRun(
          typeof action.runId === "string" ? action.runId : "run_invalid",
          context.code(error),
          context.daemonErrorMessage(error),
        );
      }
    },
    read: async (repoId, method, payload, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.cells.get(repoId);
      if (!cell)
        throw context.hostCodedError(
          context.warming.has(repoId)
            ? "repo_warming"
            : context.unavailable.has(repoId)
              ? "repo_unavailable"
              : "repo_namespace_unknown",
          context.warming.has(repoId)
            ? context.warmingMessage(repoId)
            : (context.unavailable.get(repoId)?.lastError ?? `Unknown repo namespace: ${repoId}.`),
        );
      const binding = await context.binding(cell.status().rootDir, auth);
      let result: unknown;
      if (method === "observe.tail")
        result = await cell.observeTail(payload, {
          userRoot: context.input.userRoot,
          daemonId: context.input.daemonId,
        });
      else if (method === "repo.workspace.summary.read") result = cell.workspaceSummary();
      else if (method === "repo.gui.catalog.snapshot") result = await cell.catalog.snapshot();
      else if (method === "repo.gui.catalog.preset.read") {
        if (!isJsonObject(payload))
          throw context.hostCodedError("invalid_request", "Catalog preset payload must be JSON.");
        result = await cell.catalog.preset(payload);
      } else if (method === "repo.terminal.sessions.list") result = cell.terminal.list();
      else {
        if (!isRepoCellReadMethod(method))
          throw context.hostCodedError("invalid_request", `${method} is not a repository read method.`);
        result = await cell.read(method, payload, binding);
      }
      return parseDaemonGuiReadResult(method, result);
    },
  };
}
