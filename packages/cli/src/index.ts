#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  readDaemonRegistry,
  registerDaemonRepo,
  type DaemonRegistryRepo
} from "../../kernel/src/index.ts";
import { parseArgs } from "./cli/parse-args.ts";
import { readOption, stripGlobalOptions } from "./cli/parse-options.ts";
import { appendParseFailureRuntimeEvent } from "./cli/parse-failure-runtime-event.ts";
import { calculateDaemonArtifactIdentity, type DaemonRepoNamespace } from "../../daemon/src/index.ts";
import { receiptDetailsData, renderReceiptText, toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CommandRegistryEntry } from "./cli/types.ts";
import { globalCommandOptions } from "./cli/command-spec/command-groups.ts";
import { parsePositiveIntegerOr } from "./cli/value-utils.ts";
import {
  runDaemonProductCommand,
  type DaemonServeHooks
} from "./commands/daemon/productization.ts";
import { daemonStatusCliProjection, type DaemonConnectionStats } from "./commands/daemon/status-payload.ts";
import { runDaemonConnect } from "./commands/daemon/connect.ts";
import { createDaemonLocalTransport, withDaemonSocketOwnership } from "./commands/daemon/serve-transport.ts";
import { runRegisteredCommandWithCliComposition } from "./composition/command-executor.ts";
import { selectCliAdapterProvider } from "./composition/adapter-registry.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, runCommandThroughDaemon } from "./daemon/client.ts";
import { createDaemonServiceHost } from "./daemon/service-host.ts";
import { makeDaemonReservationReconciler } from "./composition/reservation-reconciler.ts";
import { createProductionAuthorityLifecycle } from "./daemon/production-authority-lifecycle.ts";
import { loadAuthorityProductionManifest } from "./daemon/authority-production-state.ts";
import { runCompoundReceiptExitCommand } from "./daemon/compound-receipt-runner.ts";
import { runAgentRuntimeCommand } from "./commands/agent-runtime.ts";

const runRegisteredCommand = runRegisteredCommandWithCliComposition;
const daemonRuntimeProvider = selectCliAdapterProvider("daemon.runtime");
type MultiRepoHarnessDaemonRuntime = ReturnType<typeof daemonRuntimeProvider.createMultiRepoDaemonRuntime>;
export type DaemonServeRepo = DaemonRepoNamespace & Pick<DaemonRegistryRepo, "displayName" | "authorityManifestPath">;
const createMultiRepoDaemonRuntime = daemonRuntimeProvider.createMultiRepoDaemonRuntime;

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const compoundExit = await runCompoundReceiptExitCommand(argv);
  if (compoundExit !== undefined) return compoundExit;
  const daemonOverrides = stripGlobalOptions(argv);
  if (daemonOverrides.daemonMode) process.env.HARNESS_DAEMON_MODE = daemonOverrides.daemonMode;
  if (daemonOverrides.daemonProfile) process.env.HARNESS_DAEMON_PROFILE = daemonOverrides.daemonProfile;
  const daemonExit = await maybeRunDaemonCommand(argv);
  if (daemonExit !== undefined) return daemonExit;
  const agentExit = await maybeRunAgentRuntimeCommand(argv);
  if (agentExit !== undefined) return agentExit;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    await appendParseFailureRuntimeEvent(argv, parsed.error);
    emit(toCommandReceipt({ ok: false, command: "parse", error: parsed.error }), true);
    return 2;
  }

  const daemonOutput = isGithubIssuesReadCommand(parsed.value)
    ? undefined
    : await runCommandThroughDaemon(parsed.value);
  const output = daemonOutput ?? toCommandReceipt(await runRegisteredCommand(parsed.value));

  emit(output, parsed.value.json);
  return output.ok ? 0 : 1;
}

async function maybeRunAgentRuntimeCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  if (stripGlobalOptions(argv).args[0] !== "agent") return undefined;
  const outcome = await runAgentRuntimeCommand(argv);
  emit(outcome.receipt, outcome.json);
  return outcome.receipt.ok ? 0 : 1;
}

function isGithubIssuesReadCommand(command: { readonly action: { readonly kind: string } }): boolean {
  return command.action.kind === "external-snapshot" || command.action.kind === "external-list";
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
  const endpoint = readOption(args, "--socket") ?? localUserDaemonEndpoint(userRoot, daemonIdFromEnv());
  const entrypoint = fileURLToPath(import.meta.url);
  const loadedBuild = calculateDaemonArtifactIdentity(entrypoint);
  const startedAt = new Date().toISOString();
  return withDaemonSocketOwnership(endpoint, async () => {
    let runtime: MultiRepoHarnessDaemonRuntime | undefined;
    let serviceHost: Awaited<ReturnType<typeof createDaemonServiceHost>> | undefined;
    try {
      const requestedAuthorityManifest = readOption(args, "--authority-manifest")
        ?? process.env.HARNESS_AUTHORITY_MANIFEST?.trim();
      if (requestedAuthorityManifest) persistAuthorityManifestPointer(requestedAuthorityManifest, userRoot);
      const serveRepos = daemonServeRepos(rootDir, layoutOverrides, requestedRepoId, userRoot);
      const authorityManifest = requestedAuthorityManifest ?? authorityManifestFromRegistry(serveRepos);
      const defaultRepoId = defaultDaemonServeRepoId(serveRepos, rootDir, requestedRepoId);
      runtime = createMultiRepoDaemonRuntime({
        materializerPollMs: 5_000,
        reservationReconciler: async (rootInput) => {
          const canonicalRoot = typeof rootInput === "string" ? rootInput : rootInput.rootDir;
          const repoId = serveRepos.find((repo) => repo.canonicalRoot === canonicalRoot)?.repoId;
          return makeDaemonReservationReconciler(rootInput, repoId ? runtime?.getRepoRuntime(repoId) : undefined)();
        },
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
      const connections: DaemonConnectionStats = { active: 0, total: 0 };
      const authorityLifecycle = hooks.authorityLifecycle ?? (authorityManifest
        ? createProductionAuthorityLifecycle({
          manifestPath: authorityManifest,
          ...(layoutOverrides ? { layoutOverrides } : {})
        })
        : undefined);
      serviceHost = await createDaemonServiceHost(runtime, serveRepos, defaultRepoId, layoutOverrides, idleMs, endpoint, connections, userRoot, {
        entrypoint,
        loadedIdentity: loadedBuild.identity,
        startedAt
      }, authorityLifecycle);
      serviceHost.startRegistryReconcile(userRoot);
      const transport = createDaemonLocalTransport({
        daemonId: serviceHost.daemonId,
        endpoint,
        acceptSshForcedCommand: (frame) => serviceHost?.acceptsSshForcedCommand(frame.canonicalRoot) ?? false,
        ...(authorityLifecycle ? { authorityWireIngress: serviceHost.authorityWireIngress } : {}),
        createProtocolServer: serviceHost.createProtocolServer,
        onConnection: () => {
          connections.active += 1;
          connections.total += 1;
          serviceHost?.onConnectionStart();
        },
        onConnectionClosed: () => {
          connections.active = Math.max(0, connections.active - 1);
          serviceHost?.onConnectionSettled();
        }
      });
      await transport.start();
      serviceHost.onStop(async () => {
        await transport.stop();
      });
      hooks.onStarted?.(daemonStatusCliProjection(serviceHost.status()));
      serviceHost.scheduleIdleExit();
      await Promise.race([waitForStopSignal(), serviceHost.waitForStopRequest()]);
    } finally {
      let stoppedByHost = false;
      try {
        if (serviceHost) {
          await serviceHost.stop();
          stoppedByHost = true;
        } else if (runtime) {
          await runtime.stop();
        }
      } finally {
        if (!stoppedByHost && serviceHost && runtime) await runtime.stop();
      }
    }
  });
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
      displayName: repo.displayName,
      ...(repo.authorityManifestPath ? { authorityManifestPath: repo.authorityManifestPath } : {})
    }));
  }
  return [{
    repoId: requestedRepoId,
    canonicalRoot: rootDir,
    displayName: layoutOverrides?.authoredRoot ?? requestedRepoId
  }];
}

function persistAuthorityManifestPointer(manifestPath: string, userRoot: string): void {
  const manifest = loadAuthorityProductionManifest(manifestPath);
  for (const repo of manifest.repos) {
    registerDaemonRepo({
      userRoot,
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      authorityManifestPath: manifestPath
    });
  }
}

export function authorityManifestFromRegistry(repos: ReadonlyArray<DaemonServeRepo>): string | undefined {
  const pointers = [...new Set(repos.flatMap((repo) => repo.authorityManifestPath ? [repo.authorityManifestPath] : []))];
  if (pointers.length > 1) {
    throw new Error("AUTHORITY_MANIFEST_REGISTRY_CONFLICT: registered repositories require different authority manifests; start separate daemon user roots or pass --authority-manifest explicitly");
  }
  const protectedRepos = repos.filter((repo) => repo.authorityManifestPath);
  if (protectedRepos.length > 0 && protectedRepos.length !== repos.length) {
    throw new Error("AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE: authority-protected and classic repositories cannot share a daemon without an explicit manifest covering every repo");
  }
  return pointers[0];
}

function defaultDaemonServeRepoId(repos: ReadonlyArray<DaemonServeRepo>, rootDir: string, requestedRepoId: string): string {
  if (repos.some((repo) => repo.repoId === requestedRepoId)) return requestedRepoId;
  const matchingRoot = repos.find((repo) => realpathOrResolve(repo.canonicalRoot) === realpathOrResolve(rootDir));
  return matchingRoot?.repoId ?? repos[0]?.repoId ?? requestedRepoId;
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

  console.error(renderReceiptText(output));
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
      ...renderGlobalOptions(),
      "",
      "Commands:",
      ...commands.map((entry) => `  ${entry.primary} - ${entry.summary}`)
    ].join("\n");
  }
  return [
    "Usage: harness-anything <kind> [options]",
    "Alias: ha <kind> [options]",
    ...renderGlobalOptions(),
    "",
    "Commands:",
    ...commands.map((entry) => `  ${entry.primary} - ${entry.summary}`)
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
    ...renderGlobalOptions(),
    ...aliases,
    ...options,
    ...additional,
    ...examples
  ].join("\n");
}

function renderGlobalOptions(): ReadonlyArray<string> {
  return [
    "",
    "Global options:",
    ...globalCommandOptions.map((option) => `  ${option.flag.padEnd(18)} ${option.description}`)
  ];
}

function taskCreatePresetHelp(): ReadonlyArray<string> {
  return [
    "",
    "Recommended presets:",
    "  standard-task           General implementation or maintenance task; the default starting point.",
    "  long-running-task       Extended task that needs explicit long-running coordination.",
    "  module                  Module-scoped task with registered module metadata.",
    "  subtask-expansion       Plan and fan out a parent task into concrete subtasks.",
    "  github-issue-repair     Guide an agent from a GitHub issue through an evidence-backed repair.",
    "  legacy-migration        Legacy task intake or migration planning.",
    "  create-milestone        Guide creation of a milestone root task and its governed map files.",
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
