/** @daemon-transport-authority Daemon ingress filtering and repository dispatch. */
import {
  readDaemonRegistry,
  registerDaemonRepo,
  resolveHarnessLayout,
  unregisterDaemonRepo,
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
  commandClassForAction,
  commandDescriptorForAction,
  type DaemonGuiReadResultMap,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { resolveRepoBootstrap, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { openRepoCell, type RepoCell, type RepoTaskAction } from "./repo-cell.ts";
import { settingsCommandTopology } from "./repo-mode.ts";

export function createDaemonHostRepositoryApi(
  context: any,
): Pick<DaemonHost, "bootstrap" | "admin" | "run" | "replica" | "presetRun" | "read"> {
  return {
    bootstrap: async (request, auth) => {
      const prepared = resolveRepoBootstrap(request, auth);
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
      const receipt = cell.bootstrapReceipt!;
      if (!receipt.publication.ok)
        return {
          schema: "command-receipt/v2",
          ok: false,
          command: "init",
          repoId: registered.repo.repoId,
          rootDir: prepared.rootDir,
          registryChanged: registered.changed,
          ...receipt,
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
          ...receipt,
          configureVerify: {
            ok: true,
            steps,
            roots: {
              contextRoot: layout.contextRoot,
              governanceRoot: layout.governanceRoot,
              standardsRoot: layout.standardsRoot,
              adrRoot: layout.adrRoot,
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
      if (request.kind === "register") {
        await context.binding(request.rootDir, auth, "admin");
        const result = await context.attach(request.rootDir, request.repoId, request.mode);
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "daemon-repo-register",
          outcome: "applied",
          repo: result.repo,
          changed: result.changed,
          summary: [
            "repo register: repoId=",
            `${result.repo.repoId}`,
            " canonicalRoot=",
            `${result.repo.canonicalRoot}`,
            " mode=",
            `${result.repo.mode}`,
            " changed=",
            `${result.changed}`,
            "",
          ].join(""),
        };
      }
      const registry = readDaemonRegistry({ userRoot: context.input.userRoot }),
        known =
          registry.repos.some((repo) => repo.repoId === request.repoId) ||
          registry.invalidRepos.some((repo) => repo.repoId === request.repoId);
      if (!known) throw context.hostCodedError("repo_namespace_unknown", `Unknown repo namespace: ${request.repoId}.`);
      context.localOnly(auth);
      const result = unregisterDaemonRepo(request.repoId, {
        userRoot: context.input.userRoot,
        createConvenienceLinks: false,
      });
      context.settleWarming(request.repoId);
      await context.closeCell(request.repoId);
      context.unavailable.delete(request.repoId);
      const repo = context.publicRegistryRepo(result.repo);
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-repo-unregister",
        outcome: "applied",
        repo,
        changed: result.changed,
        summary: [
          "repo unregister: repoId=",
          `${repo.repoId}`,
          " canonicalRoot=",
          `${String(repo.canonicalRoot)}`,
          " changed=",
          `${result.changed}`,
          "",
        ].join(""),
      };
    },
    run: async (repoId, action, auth) => {
      const command = settingsCommandTopology(commandDescriptorForAction(action.kind), action),
        commandClass = command.commandClass,
        projectionRepair = context.localCenterProjectionRepair(repoId, action.kind, auth),
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
        const { executor: declared, ...intent } = action,
          executor = context.declaredExecutor(declared);
        const baseBinding = projectionRepair
            ? context.localRepairBinding
            : await context.binding(cell.status().rootDir, auth, commandClass, action.kind === "doc-submit", executor),
          serverBinding =
            auth.sessionEnvironment === undefined
              ? baseBinding
              : { ...baseBinding, sessionEnvironment: auth.sessionEnvironment };
        const receipt = await cell.run(intent as RepoTaskAction, serverBinding, auth.connectionSignal);
        if (action.kind.startsWith("schedule-")) await context.scheduleScheduler.refresh();
        return receipt;
      } catch (error) {
        return context.rejectHostAction(action, context.code(error), context.daemonErrorMessage(error));
      }
    },
    replica: (repoId) => context.requiredCell(context.cells, context.warming, context.unavailable, repoId).replica,
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
        const { executor: declared, ...intent } = action,
          executor = context.declaredExecutor(declared),
          routed = intent as RepoTaskAction;
        if (!cell) {
          if (missing && recoveryRunId) {
            await context.binding(missing.rootDir, auth, commandClassForAction(routed.kind), false, executor);
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
        const baseBinding = await context.binding(
          cell.status().rootDir,
          auth,
          commandClassForAction(routed.kind),
          false,
          executor,
        );
        return await cell.presetRun(
          routed,
          auth.sessionEnvironment === undefined
            ? baseBinding
            : { ...baseBinding, sessionEnvironment: auth.sessionEnvironment },
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
      await context.binding(cell.status().rootDir, auth, "repo-read");
      if (method === "observe.tail")
        return cell.observeTail(payload, {
          userRoot: context.input.userRoot,
          daemonId: context.input.daemonId,
        }) as DaemonGuiReadResultMap[typeof method];
      if (method === "repo.workspace.summary.read")
        return cell.workspaceSummary() as DaemonGuiReadResultMap[typeof method];
      if (method === "repo.gui.catalog.snapshot")
        return (await cell.catalog.snapshot()) as unknown as DaemonGuiReadResultMap[typeof method];
      if (method === "repo.gui.catalog.preset.read")
        return (await cell.catalog.preset(payload as JsonObject)) as unknown as DaemonGuiReadResultMap[typeof method];
      if (method === "repo.terminal.sessions.list")
        return cell.terminal.list() as DaemonGuiReadResultMap[typeof method];
      return cell.read(method as import("./repo-cell.ts").RepoCellReadMethod, payload) as Promise<
        DaemonGuiReadResultMap[typeof method]
      >;
    },
  };
}
