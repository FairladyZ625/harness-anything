#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliError, CliErrorCode } from "./cli/error-codes.ts";
import { parseArgs } from "./cli/parse-args.ts";
import { readOption, stripGlobalOptions } from "./cli/parse-options.ts";
import { makeLocalControllerService } from "../../application/src/index.ts";
import {
  createJsonRpcProtocolServer,
  createUnixSocketTransportServer,
  serveSshExecBridge,
  type DaemonAuthenticationContext
} from "../../daemon/src/index.ts";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../../kernel/src/index.ts";
import { receiptDetailsData, renderReceiptText, toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CommandRegistryEntry } from "./cli/types.ts";
import { parsePositiveIntegerOr } from "./cli/value-utils.ts";
import { runRegisteredCommandWithCliComposition } from "./composition/command-executor.ts";
import { selectCliAdapterProvider } from "./composition/adapter-registry.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { createCliCommandService } from "./daemon/command-service.ts";
import { makeDaemonQueuedWriteCoordinator } from "./daemon/queued-write-coordinator.ts";

type HarnessDaemonRuntime = ReturnType<typeof createDaemonRuntime>;
const runRegisteredCommand = runRegisteredCommandWithCliComposition;
const createDaemonRuntime = selectCliAdapterProvider("daemon.runtime").createDaemonRuntime;

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const daemonExit = await maybeRunDaemonCommand(argv);
  if (daemonExit !== undefined) return daemonExit;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
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
  const runtimeContext = createHarnessRuntimeContext(stripped.rootDir, layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const lockPath = path.join(layout.locksRoot, "global.lock");
  try {
    if (action === "serve") {
      await runDaemonServe(stripped.rootDir, layoutOverrides, stripped.args);
      return 0;
    }
    if (action === "start") {
      const foreground = stripped.args.includes("--foreground");
      const runtime = createDaemonRuntime({
        rootDir: stripped.rootDir,
        layoutOverrides,
        materializerPollMs: foreground ? 5_000 : false
      });
      const status = await runtime.start();
      emitDaemonResult("daemon-start", {
        ...status,
        mode: foreground ? "foreground" : "oneshot",
        guidance: "submit writes through the daemon-backed ha client/API; legacy direct WriteCoordinator writes fail closed while this lock is held"
      }, stripped.json);
      if (!foreground) {
        await runtime.stop();
        return 0;
      }
      await waitForStopSignal();
      await runtime.stop();
      return 0;
    }
    if (action === "status") {
      emitDaemonResult("daemon-status", readDaemonLock(lockPath), stripped.json);
      return 0;
    }
    if (action === "stop") {
      const status = readDaemonLock(lockPath);
      if (status.started && typeof status.pid === "number") {
        process.kill(status.pid, "SIGTERM");
      }
      emitDaemonResult("daemon-stop", { ...status, signaled: status.started }, stripped.json);
      return 0;
    }
    emitDaemonError(`unknown daemon command: ${action}`, stripped.json, CliErrorCode.UnknownCommand);
    return 2;
  } catch (error) {
    emitDaemonError(error instanceof Error ? error.message : String(error), stripped.json, CliErrorCode.JournalUnavailable);
    return 1;
  }
}

async function runDaemonServe(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  args: ReadonlyArray<string>
): Promise<void> {
  const runtime = createDaemonRuntime({
    rootDir,
    layoutOverrides,
    materializerPollMs: false
  });
  await runtime.start();
  const repoId = readOption(args, "--repo") ?? "canonical";
  const idleMs = parsePositiveIntegerOr(readOption(args, "--idle-ms"), 0, { allowZero: true });
  const serviceHost = createDaemonServiceHost(runtime, rootDir, layoutOverrides, repoId, idleMs);
  if (args.includes("--stdio")) {
    serveSshExecBridge({
      username: process.env.USER,
      host: process.env.HOSTNAME,
      createProtocolServer: serviceHost.createProtocolServer
    });
    await waitForInputEnd();
    await serviceHost.stop();
    return;
  }

  const socketPath = readOption(args, "--socket");
  const transport = createUnixSocketTransportServer({
    daemonId: serviceHost.daemonId,
    ...(socketPath ? { socketPath } : {}),
    createProtocolServer: serviceHost.createProtocolServer
  });
  await transport.start();
  serviceHost.onStop(async () => {
    await transport.stop();
  });
  serviceHost.scheduleIdleExit();
  await Promise.race([waitForStopSignal(), serviceHost.waitForStopRequest()]);
  await serviceHost.stop();
}

function createDaemonServiceHost(
  runtime: HarnessDaemonRuntime,
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  repoId: string,
  idleMs: number
): {
  readonly daemonId: string;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => ReturnType<typeof createJsonRpcProtocolServer>;
  readonly scheduleIdleExit: () => void;
  readonly waitForStopRequest: () => Promise<void>;
  readonly onStop: (handler: () => Promise<void>) => void;
  readonly stop: () => Promise<void>;
} {
  const daemonId = `ha-${process.pid}`;
  const stopHandlers: Array<() => Promise<void>> = [];
  let requestStop: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
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
  const taskWriter = selectCliAdapterProvider("task.lifecycle").createLifecycleEngine({
    rootDir,
    layoutOverrides,
    coordinator: makeDaemonQueuedWriteCoordinator(runtime, "local-controller")
  });
  const localController = makeLocalControllerService({
    rootDir,
    layoutOverrides,
    taskWriter
  });
  const cliCommandService = createCliCommandService(runtime, {
    onCommandStart: () => {
      if (idleTimer) clearTimeout(idleTimer);
    },
    onCommandSettled: scheduleIdleExit
  });
  return {
    daemonId,
    createProtocolServer: (_authContext) => createJsonRpcProtocolServer({
      daemonId,
      repos: [{ repoId, canonicalRoot: rootDir }],
      services: {
        LocalControllerService: localController,
        TerminalSessionService: makeUnavailableTerminalSessionService(),
        CliCommandService: cliCommandService
      }
    }),
    scheduleIdleExit,
    waitForStopRequest: () => stopRequested,
    onStop: (handler) => {
      stopHandlers.push(handler);
    },
    stop
  };
}

function readDaemonLock(lockPath: string): Record<string, unknown> {
  if (!existsSync(lockPath)) {
    return { started: false, lockPath };
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    readonly pid?: unknown;
    readonly hostname?: unknown;
    readonly heartbeatAt?: unknown;
    readonly ownerKind?: unknown;
  };
  return {
    started: lock.ownerKind === "daemon",
    lockPath,
    pid: lock.pid,
    hostname: lock.hostname,
    heartbeatAt: lock.heartbeatAt,
    ownerKind: lock.ownerKind
  };
}

function emitDaemonResult(command: string, result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, schema: "daemon-command/v1", command, ...result }));
    return;
  }
  const parts = [`ok`, `command=${command}`];
  if (typeof result.started === "boolean") parts.push(`started=${String(result.started)}`);
  if (typeof result.mode === "string") parts.push(`mode=${result.mode}`);
  if (typeof result.lockPath === "string") parts.push(`lock=${result.lockPath}`);
  if (typeof result.pid === "number") parts.push(`pid=${String(result.pid)}`);
  if (typeof result.guidance === "string") parts.push(`guidance=${JSON.stringify(result.guidance)}`);
  console.log(parts.join(" "));
}

function emitDaemonError(message: string, json: boolean, code: CliErrorCode): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, schema: "daemon-command/v1", command: "daemon", error: { code, hint: message } }));
    return;
  }
  console.error(`error code=${code} hint=${message}`);
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

async function waitForInputEnd(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (process.stdin.destroyed) {
      resolve();
      return;
    }
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
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
  const examples = command.examples.length > 0 ? ["", "Example:", ...command.examples.map((example) => `  ${example}`)] : [];
  return [
    `Usage: ${command.primary}`,
    "",
    command.summary,
    ...aliases,
    ...options,
    ...examples
  ].join("\n");
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
