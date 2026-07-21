#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli/parse-args.ts";
import { deprecationWarning } from "./cli/command-deprecations.ts";
import { readOption, stripGlobalOptions } from "./cli/parse-options.ts";
import { appendParseFailureRuntimeEvent } from "./cli/parse-failure-runtime-event.ts";
import {
  checkDaemonServeConfiguration as checkDaemonServeConfigurationRoot,
  runDaemonServe as runDaemonServeRoot
} from "@harness-anything/daemon";
import { runCompoundReceiptExitCommand } from "./receipt/compound-exit-command.ts";
import { receiptDetailsData, renderReceiptText, toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CommandRegistryEntry } from "./cli/types.ts";
import { globalCommandOptions } from "./cli/command-spec/command-groups.ts";
import { parsePositiveIntegerOr } from "./cli/value-utils.ts";
import {
  runDaemonProductCommand,
  type DaemonServeHooks
} from "./commands/daemon/productization.ts";
import { daemonStatusCliProjection } from "./commands/daemon/status-payload.ts";
import { runDaemonConnect } from "./commands/daemon/connect.ts";
import { runRegisteredCommandWithCliComposition } from "./composition/command-executor.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, runCommandThroughDaemon } from "./daemon/client.ts";
import {
  parseDaemonLaunchArgv,
  preflightDaemonLaunch,
  resolveCompleteDaemonLaunchSpec,
  resolveDaemonLaunchSpec,
  type ParsedDaemonLaunchArgv
} from "./daemon/daemon-launch-spec.ts";
import { daemonRuntimeLayoutOverrides } from "./daemon/daemon-serve-launch-options.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "./composition/production-authority-lifecycle.ts";
import { runAgentRuntimeCommand } from "./commands/agent-runtime.ts";
import { runTaskSubmitFacade } from "./commands/core/task-submit-facade.ts";
import { runTaskCloseoutFacade, runTaskStartFacade } from "./commands/core/task-lifecycle-facade.ts";
import { isDeclaredLocalMigrationCommand } from "./composition/local-write-scope.ts";
import { startCliTimingPhase } from "./cli/timing.ts";

const runRegisteredCommand = runRegisteredCommandWithCliComposition;
type ParsedCommandRunner = (command: Parameters<typeof runRegisteredCommand>[0]) => Promise<CommandReceipt | CommandFailureReceipt>;
const cliTestFixtureRunnerSymbol = Symbol.for("harness-anything.cli-test-fixture-runner");

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

  const finishParse = startCliTimingPhase("parse");
  const parsed = parseArgs(argv);
  finishParse();
  if (!parsed.ok) {
    await appendParseFailureRuntimeEvent(argv, parsed.error);
    emit(toCommandReceipt({ ok: false, command: "parse", error: parsed.error }), true);
    return 2;
  }

  if (parsed.value.deprecatedInvocation) console.error(deprecationWarning(parsed.value.deprecatedInvocation));

  const output = parsed.value.action.kind === "task-submit"
    ? await runTaskSubmitFacade(parsed.value, runParsedCommand)
    : parsed.value.action.kind === "task-start"
      ? await runTaskStartFacade(parsed.value, runParsedCommand)
      : parsed.value.action.kind === "task-closeout"
        ? await runTaskCloseoutFacade(parsed.value, runParsedCommand)
        : await runParsedCommand(parsed.value);

  const receipt = "schema" in output ? output : toCommandReceipt(output);
  emit(receipt, parsed.value.json);
  return receipt.ok ? 0 : 1;
}

async function runParsedCommand(command: Parameters<typeof runRegisteredCommand>[0]): Promise<CommandReceipt | CommandFailureReceipt> {
  const configuredMode = process.env.HARNESS_DAEMON_MODE;
  const testFixtureCommandRunner = (globalThis as Record<symbol, unknown>)[cliTestFixtureRunnerSymbol] as ParsedCommandRunner | undefined;
  if (testFixtureCommandRunner && configuredMode !== "direct" && configuredMode !== "local" && configuredMode !== "remote") {
    return runTimedCommand(() => testFixtureCommandRunner(command));
  }
  if (isDaemonIndependentCommand(command) || isGithubIssuesReadCommand(command)) {
    return runLocalRegisteredCommand(command);
  }
  const slowDaemonNotice = setTimeout(() => {
    console.error("[ha] Waiting for daemon readiness or command completion; authority admission remains enforced.");
  }, 1_000);
  slowDaemonNotice.unref();
  let daemonOutput: CommandReceipt | CommandFailureReceipt | undefined;
  try {
    daemonOutput = await runCommandThroughDaemon(command);
  } finally {
    clearTimeout(slowDaemonNotice);
  }
  return daemonOutput ?? runLocalRegisteredCommand(command);
}

async function runLocalRegisteredCommand(
  command: Parameters<typeof runRegisteredCommand>[0]
): Promise<CommandReceipt | CommandFailureReceipt> {
  return runTimedCommand(async () => toCommandReceipt(await runRegisteredCommand(command, {
    ...(isDeclaredLocalMigrationCommand(command.action)
      ? { localCoordinatorScope: "migration" }
      : process.env.HARNESS_DAEMON_MODE === "direct" && process.env.HARNESS_DIRECT_WRITE_REASON === "recovery"
        ? { localCoordinatorScope: "recovery" }
        : {})
  })));
}

async function runTimedCommand<T>(run: () => Promise<T>): Promise<T> {
  const finish = startCliTimingPhase("command_execute");
  try {
    return await run();
  } finally {
    finish();
  }
}

function isDaemonIndependentCommand(command: { readonly action: { readonly kind: string } }): boolean {
  return command.action.kind === "help"
    || command.action.kind === "version"
    || command.action.kind === "entity-list"
    || command.action.kind === "capabilities"
    || command.action.kind === "completion"
    || command.action.kind === "git-diff";
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
  const layoutOverrides = stripped.authoredRoot !== undefined || argv.includes("--authored-root")
    ? { authoredRoot: stripped.authoredRoot ?? "" }
    : undefined;
  const daemonArgs = stripped.daemonRepoId ? [...stripped.args, "--repo", stripped.daemonRepoId] : stripped.args;
  if (action === "connect") return runDaemonConnect(stripped.args, {
    ...(readOption(argv, "--root") ? { rootDir: stripped.rootDir } : {}),
    ...(layoutOverrides ? { layoutOverrides } : {})
  });
  if (action === "serve") {
    let launchOptions: ParsedDaemonLaunchArgv;
    try {
      launchOptions = parseDaemonLaunchArgv(argv);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    const serveLayoutOverrides = daemonRuntimeLayoutOverrides(launchOptions.rootDir, launchOptions.authoredRoot);
    if (daemonArgs.includes("--stdio")) {
      console.error("daemon serve --stdio is disabled because it creates a competing runtime; start the persistent daemon and use 'ha daemon connect --stdio'.");
      return 2;
    }
    if (daemonArgs.includes("--check")) {
      checkDaemonServeConfiguration(launchOptions.rootDir, serveLayoutOverrides, daemonArgs.filter((arg) => arg !== "--check"), launchOptions);
      return 0;
    }
    await runDaemonServe(launchOptions.rootDir, serveLayoutOverrides, daemonArgs, {}, launchOptions);
    return 0;
  }
  return runDaemonProductCommand({
    rootDir: stripped.rootDir,
    layoutOverrides,
    json: stripped.json,
    args: daemonArgs,
    rawArgs: argv,
    runServe: runDaemonServe
  });
}

function checkDaemonServeConfiguration(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  args: ReadonlyArray<string>,
  launchOptions: ParsedDaemonLaunchArgv
): void {
  const userRoot = launchOptions.userRoot ?? daemonUserRoot();
  checkDaemonServeConfigurationRoot({
    rootDir,
    layoutOverrides,
    userRoot,
    endpoint: launchOptions.socketPath ?? localUserDaemonEndpoint(userRoot, daemonIdFromEnv()),
    requestedRepoId: readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID ?? "canonical",
    ...(launchOptions.authorityManifest ? { requestedAuthorityManifest: launchOptions.authorityManifest } : {})
  });
}

async function runDaemonServe(
  rootDir: string,
  _layoutOverrides: { readonly authoredRoot?: string } | undefined,
  args: ReadonlyArray<string>,
  hooks: DaemonServeHooks = {},
  parsedLaunchOptions = parseDaemonLaunchArgv(args)
): Promise<void> {
  const implementationPath = fileURLToPath(import.meta.url);
  const entrypoint = path.join(path.dirname(implementationPath), `index${path.extname(implementationPath)}`);
  const requestedUserRoot = parsedLaunchOptions.userRoot ?? daemonUserRoot();
  const requestedEndpoint = parsedLaunchOptions.socketPath ?? localUserDaemonEndpoint(requestedUserRoot, daemonIdFromEnv());
  const explicit = {
    ...(parsedLaunchOptions.authorityManifest ? { authorityManifest: parsedLaunchOptions.authorityManifest } : {}),
    ...(parsedLaunchOptions.authoredRoot ? { authoredRoot: parsedLaunchOptions.authoredRoot } : {})
  };
  const restoredSpec = parsedLaunchOptions.optionsResolved
    ? resolveCompleteDaemonLaunchSpec(requestedEndpoint, explicit)
    : resolveDaemonLaunchSpec(requestedUserRoot, requestedEndpoint, explicit);
  const restoredAuthoredRoot = restoredSpec.options.authoredRoot;
  const restoredLayoutOverrides = daemonRuntimeLayoutOverrides(rootDir, restoredAuthoredRoot);
  const restoredLaunchOptions = Object.freeze({
    ...parsedLaunchOptions,
    ...restoredSpec.options,
    socketPath: restoredSpec.endpoint,
    userRoot: requestedUserRoot
  });
  const requestedRepoId = readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID ?? "canonical";
  const { cliDaemonServiceHostServices } = await import("./composition/daemon-service-host-services.ts");
  await runDaemonServeRoot({
    rootDir,
    ...(restoredAuthoredRoot !== undefined ? { authoredRoot: restoredAuthoredRoot } : {}),
    layoutOverrides: restoredLayoutOverrides,
    userRoot: requestedUserRoot,
    endpoint: restoredSpec.endpoint,
    requestedRepoId,
    ...(restoredLaunchOptions.authorityManifest ? { requestedAuthorityManifest: restoredLaunchOptions.authorityManifest } : {}),
    entrypoint,
    idleMs: parsePositiveIntegerOr(readOption(args, "--idle-ms"), 0, { allowZero: true }),
    preflightReplacement: preflightDaemonLaunch
  }, cliDaemonServiceHostServices, {
    persistLaunchConfiguration: (userRoot, configuration, effectiveOptions) => restoredSpec
      .withEffectiveOptions(effectiveOptions)
      .persist(userRoot, configuration),
    createAuthorityLifecycle: createProductionAuthorityLifecycle,
    projectStartedStatus: daemonStatusCliProjection
  }, hooks);
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
