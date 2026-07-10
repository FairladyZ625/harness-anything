#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  readDaemonRegistry,
  type DaemonRegistryRepo
} from "../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "./cli/error-codes.ts";
import { parseArgs } from "./cli/parse-args.ts";
import { readOption, stripGlobalOptions } from "./cli/parse-options.ts";
import { makeLocalControllerService, makeRuntimeEventAppendPromise, makeRuntimeEventLedgerService, makeTaskHolderService } from "../../application/src/index.ts";
import { appendParseFailureRuntimeEvent } from "./cli/parse-failure-runtime-event.ts";
import {
  createJsonRpcProtocolServer,
  type DaemonRepoAvailabilityFailure,
  type DaemonRepoNamespace,
  type DaemonAuthenticationContext
} from "../../daemon/src/index.ts";
import { receiptDetailsData, renderReceiptText, toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CommandRegistryEntry } from "./cli/types.ts";
import { parsePositiveIntegerOr } from "./cli/value-utils.ts";
import {
  daemonStatusPayload,
  loadDaemonIdentity,
  runDaemonProductCommand,
  type DaemonConnectionStats,
  type DaemonServeHooks
} from "./commands/daemon/productization.ts";
import { runDaemonConnect } from "./commands/daemon/connect.ts";
import { createDaemonLocalTransport } from "./commands/daemon/serve-transport.ts";
import { runRegisteredCommandWithCliComposition } from "./composition/command-executor.ts";
import { selectCliAdapterProvider } from "./composition/adapter-registry.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, runCommandThroughDaemon } from "./daemon/client.ts";
import { createCliCommandService } from "./daemon/command-service.ts";
import { makeDocSyncService } from "./daemon/doc-sync-service.ts";
import { makeDaemonQueuedWriteCoordinator } from "./daemon/queued-write-coordinator.ts";
import { leaseEnforcementEnabled } from "./commands/settings.ts";
import { makeMarkdownArtifactStore } from "../../kernel/src/index.ts";

const runRegisteredCommand = runRegisteredCommandWithCliComposition;
const daemonRuntimeProvider = selectCliAdapterProvider("daemon.runtime");
type HarnessDaemonRuntime = ReturnType<typeof daemonRuntimeProvider.createDaemonRuntime>;
type MultiRepoHarnessDaemonRuntime = ReturnType<typeof daemonRuntimeProvider.createMultiRepoDaemonRuntime>;
type RepoServiceBinding = ReturnType<typeof createRepoServiceBinding>;
type DaemonServeRepo = DaemonRepoNamespace & Pick<DaemonRegistryRepo, "displayName">;
const createMultiRepoDaemonRuntime = daemonRuntimeProvider.createMultiRepoDaemonRuntime;

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const daemonExit = await maybeRunDaemonCommand(argv);
  if (daemonExit !== undefined) return daemonExit;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    await appendParseFailureRuntimeEvent(argv, parsed.error);
    emit(toCommandReceipt({ ok: false, command: "parse", error: parsed.error }), true);
    return 2;
  }

  const daemonOutput = await runCommandThroughDaemon(parsed.value);
  const output = daemonOutput ?? toCommandReceipt(await runRegisteredCommand(parsed.value));

  emit(output, parsed.value.json);
  return output.ok ? 0 : 1;
}

async function maybeRunDaemonCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  const stripped = stripGlobalOptions(argv);
  if (stripped.args[0] !== "daemon") return undefined;
  const action = stripped.args[1] ?? "status";
  const layoutOverrides = stripped.authoredRoot ? { authoredRoot: stripped.authoredRoot } : undefined;
  const daemonArgs = stripped.daemonRepoId ? [...stripped.args, "--repo", stripped.daemonRepoId] : stripped.args;
  if (action === "connect") return runDaemonConnect(stripped.args, {
    ...(readOption(argv, "--root") ? { rootDir: stripped.rootDir } : {})
  });
  if (action === "serve") {
    if (daemonArgs.includes("--stdio")) {
      console.error("daemon serve --stdio is disabled because it creates a competing runtime; start the persistent daemon and use 'ha daemon connect --stdio'.");
      return 2;
    }
    await runDaemonServe(stripped.rootDir, layoutOverrides, daemonArgs);
    return 0;
  }
  return runDaemonProductCommand({
    rootDir: stripped.rootDir,
    layoutOverrides,
    json: stripped.json,
    args: daemonArgs,
    runServe: runDaemonServe
  });
}

async function runDaemonServe(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  args: ReadonlyArray<string>,
  hooks: DaemonServeHooks = {}
): Promise<void> {
  const requestedRepoId = readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID ?? "canonical";
  const userRoot = readOption(args, "--user-root") ?? daemonUserRoot();
  const serveRepos = daemonServeRepos(rootDir, layoutOverrides, requestedRepoId, userRoot);
  const defaultRepoId = defaultDaemonServeRepoId(serveRepos, rootDir, requestedRepoId);
  const runtime = createMultiRepoDaemonRuntime({
    materializerPollMs: 5_000,
    repos: serveRepos.map((repo) => ({
      repoId: repo.repoId,
      rootDir: repo.canonicalRoot,
      displayName: repo.displayName,
      ...(layoutOverrides ? { layoutOverrides } : {})
    }))
  });
  const startStatus = await runtime.start();
  if (startStatus.repoCount > 0 && startStatus.attachedCount === 0 && startStatus.unavailableCount > 0) {
    throw new Error(`daemon did not attach any registered repo: ${startStatus.repos.map((repo) => `${repo.repoId}:${repo.lastError ?? repo.state}`).join("; ")}`);
  }
  const idleMs = parsePositiveIntegerOr(readOption(args, "--idle-ms"), 0, { allowZero: true });
  const endpoint = readOption(args, "--socket") ?? localUserDaemonEndpoint(userRoot, daemonIdFromEnv());
  const connections: DaemonConnectionStats = { active: 0, total: 0 };
  const serviceHost = createDaemonServiceHost(runtime, serveRepos, defaultRepoId, layoutOverrides, idleMs, endpoint, connections);
  serviceHost.startRegistryReconcile(userRoot);
  const transport = createDaemonLocalTransport({
    daemonId: serviceHost.daemonId,
    endpoint,
    createProtocolServer: serviceHost.createProtocolServer,
    onConnection: () => {
      connections.active += 1;
      connections.total += 1;
    },
    onConnectionClosed: () => {
      connections.active = Math.max(0, connections.active - 1);
    }
  });
  await transport.start();
  hooks.onStarted?.(serviceHost.status());
  serviceHost.onStop(async () => {
    await transport.stop();
  });
  serviceHost.scheduleIdleExit();
  await Promise.race([waitForStopSignal(), serviceHost.waitForStopRequest()]);
  await serviceHost.stop();
}

function repoAvailabilityFailure(
  runtime: MultiRepoHarnessDaemonRuntime,
  repo: DaemonRepoNamespace
): DaemonRepoAvailabilityFailure | undefined {
  const status = runtime.status().repos.find((candidate) => candidate.repoId === repo.repoId);
  if (!status) {
    return {
      code: "repo_unavailable",
      repo: {
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        state: "unavailable",
        lockPath: null,
        lockOwnerToken: null,
        lastError: "runtime context not found"
      }
    };
  }
  if (status.state === "attached") return undefined;
  const lockHeld = typeof status.lastError === "string" && /lock already held|global\.lock/u.test(status.lastError);
  return {
    code: lockHeld ? "repo_lock_held" : "repo_unavailable",
    repo: {
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      state: status.state,
      lockPath: status.lockPath ?? null,
      lockOwnerToken: status.lockOwnerToken ?? null,
      lastError: status.lastError ?? null
    }
  };
}

function daemonServeRepos(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  requestedRepoId: string,
  userRoot: string
): ReadonlyArray<DaemonServeRepo> {
  const enabledRepos = readDaemonRegistry({ userRoot }).repos.filter((repo) => repo.state === "enabled");
  if (enabledRepos.length > 0) {
    return enabledRepos.map((repo) => ({
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      displayName: repo.displayName
    }));
  }
  return [{
    repoId: requestedRepoId,
    canonicalRoot: rootDir,
    displayName: layoutOverrides?.authoredRoot ?? requestedRepoId
  }];
}

function defaultDaemonServeRepoId(repos: ReadonlyArray<DaemonServeRepo>, rootDir: string, requestedRepoId: string): string {
  if (repos.some((repo) => repo.repoId === requestedRepoId)) return requestedRepoId;
  const matchingRoot = repos.find((repo) => realpathOrResolve(repo.canonicalRoot) === realpathOrResolve(rootDir));
  return matchingRoot?.repoId ?? repos[0]?.repoId ?? requestedRepoId;
}

function sortedDaemonRepos(repos: ReadonlyArray<DaemonRepoNamespace>): ReadonlyArray<DaemonRepoNamespace> {
  return [...repos].sort((left, right) => left.repoId.localeCompare(right.repoId) || left.canonicalRoot.localeCompare(right.canonicalRoot));
}

function createDaemonServiceHost(
  runtime: MultiRepoHarnessDaemonRuntime,
  repos: ReadonlyArray<DaemonRepoNamespace>,
  defaultRepoId: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  idleMs: number,
  endpoint: string,
  connections: DaemonConnectionStats
): {
  readonly daemonId: string;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => ReturnType<typeof createJsonRpcProtocolServer>;
  readonly status: () => Record<string, unknown>;
  readonly scheduleIdleExit: () => void;
  readonly waitForStopRequest: () => Promise<void>;
  readonly onStop: (handler: () => Promise<void>) => void;
  readonly startRegistryReconcile: (userRoot: string) => void;
  readonly stop: () => Promise<void>;
} {
  const daemonId = `ha-${process.pid}`;
  const stopHandlers: Array<() => Promise<void>> = [];
  const reposById = new Map(repos.map((repo) => [repo.repoId, repo]));
  let requestStop: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciling = false;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    for (const handler of stopHandlers.splice(0, stopHandlers.length)) {
      await handler();
    }
    await runtime.stop();
  };
  const scheduleIdleExit = () => {
    if (idleMs <= 0 || stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      requestStop?.();
    }, idleMs);
    idleTimer.unref();
  };
  const repoBindings = new Map(repos.map((repo) => {
    const repoRuntime = runtime.getRepoRuntime(repo.repoId);
    if (!repoRuntime) throw new Error(`daemon runtime missing repo context: ${repo.repoId}`);
    return [repo.repoId, createRepoServiceBinding(repo, repoRuntime, runtime, layoutOverrides, {
      onCommandStart: () => {
        if (idleTimer) clearTimeout(idleTimer);
      },
      onCommandSettled: scheduleIdleExit
    }, { daemonId, endpoint, connections })] as const;
  }));
  return {
    daemonId,
    createProtocolServer: (authContext) => createJsonRpcProtocolServer({
      daemonId,
      repos: sortedDaemonRepos([...reposById.values()]),
      services: defaultRepoBinding().services,
      resolveRepoServices: (repo) => repoBindings.get(repo.repoId)?.services,
      resolveRepoAvailability: (repo) => repoAvailabilityFailure(runtime, repo),
      leaseEnforcementEnabled: (repo) => leaseEnforcementEnabled({ rootDir: repo.canonicalRoot, layoutOverrides }),
      authContext,
      ...(defaultRepoBinding().identity.identityProvider ? { identityProvider: defaultRepoBinding().identity.identityProvider } : {}),
      ...(defaultRepoBinding().identity.peopleRoster ? { peopleRoster: defaultRepoBinding().identity.peopleRoster } : {}),
      appendRuntimeEvent: (input, context) => {
        const targetRepoId = context?.repo.repoId ?? defaultRepoId;
        return repoBindings.get(targetRepoId)?.appendRuntimeEvent(input) ?? Promise.resolve();
      }
    }),
    status: () => daemonStatusPayload({
      daemonId,
      rootDir: defaultRepoBinding().repo.canonicalRoot,
      repoId: defaultRepoBinding().repo.repoId,
      endpoint,
      runtimeStatus: runtime.status(),
      connections
    }),
    scheduleIdleExit,
    waitForStopRequest: () => stopRequested,
    onStop: (handler) => {
      stopHandlers.push(handler);
    },
    startRegistryReconcile: (userRoot) => {
      if (reconcileTimer || stopping) return;
      const reconcile = async () => {
        if (reconciling || stopping) return;
        reconciling = true;
        try {
          await reconcileDaemonRepos(userRoot);
        } finally {
          reconciling = false;
        }
      };
      reconcileTimer = setInterval(() => {
        void reconcile().catch(() => undefined);
      }, 1_000);
      reconcileTimer.unref();
    },
    stop
  };

  function defaultRepoBinding(): RepoServiceBinding {
    const binding = repoBindings.get(defaultRepoId) ?? repoBindings.values().next().value;
    if (!binding) throw new Error("daemon service host has no repo bindings");
    return binding;
  }

  async function reconcileDaemonRepos(userRoot: string): Promise<void> {
    const desiredRepos = readDaemonRegistry({ userRoot }).repos.filter((repo) => repo.state === "enabled");
    if (desiredRepos.length === 0) return;
    const desiredIds = new Set(desiredRepos.map((repo) => repo.repoId));
    for (const repo of desiredRepos) {
      if (!reposById.has(repo.repoId)) {
        const namespace = { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot } satisfies DaemonRepoNamespace;
        reposById.set(repo.repoId, namespace);
      }
      if (!runtime.getRepoRuntime(repo.repoId)) {
        await runtime.attachRepo({ repoId: repo.repoId, rootDir: repo.canonicalRoot, displayName: repo.displayName, ...(layoutOverrides ? { layoutOverrides } : {}) });
      }
      if (!repoBindings.has(repo.repoId)) {
        const repoRuntime = runtime.getRepoRuntime(repo.repoId);
        if (repoRuntime) {
          repoBindings.set(repo.repoId, createRepoServiceBinding(reposById.get(repo.repoId)!, repoRuntime, runtime, layoutOverrides, {
            onCommandStart: () => {
              if (idleTimer) clearTimeout(idleTimer);
            },
            onCommandSettled: scheduleIdleExit
          }, { daemonId, endpoint, connections }));
        }
      }
    }
    for (const repoId of [...reposById.keys()]) {
      if (desiredIds.has(repoId)) continue;
      repoBindings.delete(repoId);
      reposById.delete(repoId);
      if (runtime.getRepoRuntime(repoId)) await runtime.detachRepo(repoId);
    }
    await runtime.retryUnavailableRepos();
  }
}

function createRepoServiceBinding(
  repo: DaemonRepoNamespace,
  runtime: HarnessDaemonRuntime,
  managerRuntime: MultiRepoHarnessDaemonRuntime,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  commandOptions: { readonly onCommandStart: () => void; readonly onCommandSettled: () => void },
  statusOptions?: { readonly daemonId?: string; readonly endpoint?: string; readonly connections?: DaemonConnectionStats }
): {
  readonly repo: DaemonRepoNamespace;
  readonly identity: ReturnType<typeof loadDaemonIdentity>;
  readonly services: Parameters<typeof createJsonRpcProtocolServer>[0]["services"];
  readonly appendRuntimeEvent: ReturnType<typeof makeRuntimeEventAppendPromise>;
} {
  const rootDir = repo.canonicalRoot;
  const identity = loadDaemonIdentity(rootDir, layoutOverrides);
  const taskWriter = selectCliAdapterProvider("task.lifecycle").createLifecycleEngine({
    rootDir,
    layoutOverrides,
    coordinator: makeDaemonQueuedWriteCoordinator(runtime, "local-controller")
  });
  const localController = makeLocalControllerService({
    rootDir,
    layoutOverrides,
    taskWriter,
    artifactStore: makeMarkdownArtifactStore({ rootDir, layoutOverrides })
  });
  const taskHolderService = makeTaskHolderService({ rootInput: { rootDir, layoutOverrides } });
  const cliCommandService = createCliCommandService(runtime, commandOptions);
  const docSyncService = makeDocSyncService({ rootDir, layoutOverrides });
  const appendRuntimeEvent = makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({
    rootInput: { rootDir, layoutOverrides },
    coordinator: makeDaemonQueuedWriteCoordinator(runtime, "runtime-event-protocol")
  }));
  return {
    repo,
    identity,
    services: {
      LocalControllerService: localController,
      TerminalSessionService: makeUnavailableTerminalSessionService(),
      TaskHolderService: taskHolderService,
      DaemonStatusService: {
        getStatus: (context) => {
          const targetRepo = context?.repo ?? repo;
          return daemonStatusPayload({
            daemonId: statusOptions?.daemonId ?? `ha-${process.pid}`,
            rootDir: targetRepo.canonicalRoot,
            repoId: targetRepo.repoId,
            endpoint: statusOptions?.endpoint ?? "repo-router",
            runtimeStatus: managerRuntime.status(),
            connections: statusOptions?.connections ?? { active: 0, total: 0 }
          });
        }
      },
      CliCommandService: cliCommandService,
      DocSyncService: {
        submit: (request) => runtime.enqueueBackgroundBatch({
          source: "doc-sync-submit",
          priority: "normal",
          run: () => docSyncService.submit(request)
        })
      }
    },
    appendRuntimeEvent
  };
}

async function waitForStopSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function emit(output: CommandReceipt | CommandFailureReceipt, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(output));
    return;
  }

  if (output.ok) {
    const data = receiptDetailsData(output);
    if (output.command === "version") {
      console.log(`harness-anything ${String(data.version ?? "unknown")}`);
      return;
    }
    if (output.command === "help" && Array.isArray(data.commands)) {
      console.log(renderHelp(data));
      return;
    }
    console.log(renderReceiptText(output));
    return;
  }

  console.error(`error code=${output.error?.code ?? "unknown"} hint=${output.error?.hint ?? "Command failed."}`);
}

function renderHelp(result: Record<string, unknown>): string {
  const commands = Array.isArray(result.commands) ? result.commands as ReadonlyArray<CommandRegistryEntry> : [];
  const report = helpReport(result.report);
  if (report?.kind === "command" && commands.length === 1) {
    return renderCommandHelp(commands[0]!);
  }
  if (report?.kind === "prefix") {
    const prefix = Array.isArray(report.prefix) ? report.prefix.join(" ") : "";
    return [
      `Usage: harness-anything ${prefix} <subcommand> [options]`,
      `Alias: ha ${prefix} <subcommand> [options]`,
      "",
      "Commands:",
      ...commands.map((entry) => `  ${entry.primary} - ${entry.summary}`)
    ].join("\n");
  }
  return [
    "Usage: harness-anything <command> [options]",
    "Alias: ha <command> [options]",
    "",
    "Commands:",
    ...commands.map((entry) => `  ${entry.primary}`)
  ].join("\n");
}

function renderCommandHelp(command: CommandRegistryEntry): string {
  const aliases = command.aliases.length > 0 ? ["", "Aliases:", ...command.aliases.map((alias) => `  ${alias}`)] : [];
  const options = command.options.length > 0 ? ["", "Options:", ...command.options.map((option) => `  ${option.flag.padEnd(18)} ${option.description}`)] : [];
  const additional = command.kind === "new-task" ? taskCreatePresetHelp() : [];
  const examples = command.examples.length > 0 ? ["", "Example:", ...command.examples.map((example) => `  ${example}`)] : [];
  return [
    `Usage: ${command.primary}`,
    "",
    command.summary,
    ...aliases,
    ...options,
    ...additional,
    ...examples
  ].join("\n");
}

function taskCreatePresetHelp(): ReadonlyArray<string> {
  return [
    "",
    "Recommended presets:",
    "  standard-task           General implementation or maintenance task; the default starting point.",
    "  long-running-task       Extended task that needs explicit long-running coordination.",
    "  module                  Module-scoped task with registered module metadata.",
    "  subtask-expansion       Plan and fan out a parent task into concrete subtasks.",
    "  github-issue-repair     Pull a GitHub issue and prepare an evidence-backed repair plan.",
    "  legacy-migration        Legacy task intake or migration planning.",
    "  create-milestone        Create a milestone root task, then scaffold and check the milestone map files.",
    "  decision-conformance    Work that must prove alignment with recorded decisions.",
    "  milestone-closeout      Milestone wrap-up checks and evidence collection.",
    "",
    "Start here:",
    "  ha task create --title \"...\" --vertical software/coding --preset <id>",
    "  ha task create --title \"<name> milestone root\" --vertical software/coding --preset create-milestone --long-running"
  ];
}

function helpReport(report: unknown): { readonly kind: "global" | "command" | "prefix"; readonly prefix?: unknown } | undefined {
  if (!report || typeof report !== "object") return undefined;
  const candidate = report as { readonly schema?: unknown; readonly kind?: unknown; readonly prefix?: unknown };
  if (candidate.schema !== "cli-help-report/v1") return undefined;
  if (candidate.kind !== "global" && candidate.kind !== "command" && candidate.kind !== "prefix") return undefined;
  return { kind: candidate.kind, prefix: candidate.prefix };
}

function makeUnavailableTerminalSessionService() {
  const failure = {
    ok: false as const,
    error: cliError(CliErrorCode.TerminalServiceUnavailable, "Terminal sessions are not available from the CLI daemon command server.")
  };
  return {
    createSession: () => failure,
    listSessions: () => ({ ok: true as const, sessions: [] }),
    getSession: () => failure,
    attachSession: () => failure,
    resizeSession: () => failure,
    closeSession: () => failure
  };
}

function realpathOrResolve(rootDir: string): string {
  try {
    return realpathSync(rootDir);
  } catch {
    return rootDir;
  }
}

function isCliEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return invokedPath.endsWith("packages/cli/src/index.ts");
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await main();
}
