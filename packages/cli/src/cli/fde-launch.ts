import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { daemonIdFromEnv, daemonUserRoot } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { guiStdioLogPath } from "@harness-anything/daemon/internal/lifecycle-log";
import { startDetachedProcess } from "@harness-anything/daemon/internal/process-port";
import { cliErrorMessage } from "../cli-error.ts";
import { cliFailure } from "../cli-meta.ts";
import { consumeKnownError } from "../daemon/client.ts";

// dec_42EB7B8F636C12381A447E52A3/CH2: CLI resolves @harness-anything/gui-fde dynamically at runtime
// so packages/cli retains zero static dependency edge on packages/gui-fde.
const LOOPBACK_HOST = "127.0.0.1";
const FDE_LAUNCH_TIMEOUT_MS = cliOperationalPolicy.defaultValue.waitMaximumMs;

type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;

export interface FdeBrowserServerHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface FdeElectronRuntime {
  readonly binary?: string;
  readonly installScript?: string;
  readonly remedy: string;
}

export interface FdeLaunchReadinessSignal {
  readonly ok: boolean;
  readonly mode?: string;
  readonly pid?: number;
  readonly reason?: string;
  readonly detail?: string;
}

export interface FdeLaunchDependencies {
  readonly fdePackageRoot?: string;
  readonly resolveFdePackageRoot?: () => string | undefined;
  readonly resolveElectronRuntime?: (fdePackageRoot: string) => FdeElectronRuntime;
  readonly startBrowserServer?: (options: {
    readonly fdePackageRoot: string;
    readonly rootDir: string;
    readonly port?: number;
  }) => Promise<FdeBrowserServerHandle>;
  readonly waitForBrowserClose?: (server: FdeBrowserServerHandle) => Promise<void>;
  readonly startDetached?: typeof startDetachedProcess;
  readonly waitForReady?: (context: {
    readonly child: ReturnType<typeof startDetachedProcess>;
    readonly logPath: string;
    readonly addr: string;
    readonly token: string;
  }) => Promise<FdeLaunchReadinessSignal>;
}

export async function runFdeLaunch(
  argv: readonly string[],
  dependencies: FdeLaunchDependencies,
  renderReceipt: ReceiptEmitter,
): Promise<number> {
  const json = argv.includes("--json");
  const finish = (receipt: Record<string, unknown>, exitCode: number) => {
    renderReceipt(
      {
        schema: "command-receipt/v2",
        command: "fde",
        outcome: receipt.ok === true ? "applied" : "rejected",
        ...receipt,
      },
      json,
    );
    return exitCode;
  };
  const reject = (errorCode: string, hint: string, exitCode = 1) =>
    finish(cliFailure("fde", errorCode, hint), exitCode);

  const launch = parseFdeLaunch(argv);
  if (!launch.ok) return reject(launch.code, launch.hint, 2);

  const fdePackageRoot = dependencies.fdePackageRoot ?? (dependencies.resolveFdePackageRoot ?? resolveFdePackageRoot)();
  if (!fdePackageRoot) {
    return reject(
      "fde_unavailable",
      "The GUI-FDE workbench package (@harness-anything/gui-fde) is not installed in this checkout. " +
        "Build or install @harness-anything/gui-fde, then retry `ha fde`.",
    );
  }

  const rendererBundle = path.join(fdePackageRoot, "dist/index.html");
  if (!existsSync(rendererBundle)) {
    return reject(
      "fde_build_failed",
      `The GUI-FDE renderer bundle ${rendererBundle} is missing. Run \`npm run build -w @harness-anything/gui-fde\`, then retry \`ha fde\`.`,
    );
  }

  try {
    if (launch.browser) {
      const server = await (dependencies.startBrowserServer ?? startFdeBrowserServer)({
        fdePackageRoot,
        rootDir: launch.rootDir,
        ...(launch.port !== undefined ? { port: launch.port } : {}),
      });
      finish(
        {
          ok: true,
          command: "fde",
          mode: "browser",
          url: server.url,
          rootDir: launch.rootDir,
          summary: `Harness Anything GUI-FDE available at ${server.url}`,
        },
        0,
      );
      await (dependencies.waitForBrowserClose ?? waitForBrowserClose)(server);
      return 0;
    }

    const preloadBundle = path.join(fdePackageRoot, "dist-electron/electron-preload.cjs");
    const mainBundle = path.join(fdePackageRoot, "dist-electron/electron-main.js");
    if (!existsSync(preloadBundle) || !existsSync(mainBundle)) {
      return reject(
        "fde_build_failed",
        "The GUI-FDE desktop bundles are missing. Run `npm run build -w @harness-anything/gui-fde`, then retry `ha fde`.",
      );
    }

    const electronRuntime = (dependencies.resolveElectronRuntime ?? resolveFdeElectronRuntime)(fdePackageRoot);
    if (!electronRuntime.binary) return reject("electron_unavailable", electronRuntime.remedy);

    const logPath = guiStdioLogPath(daemonUserRoot(), daemonIdFromEnv());
    return await launchDesktopFde({
      rootDir: launch.rootDir,
      fdePackageRoot,
      mainBundle,
      electronRuntime,
      logPath,
      dependencies,
      finish,
      reject,
    });
  } catch (error) {
    return reject("fde_launch_failed", `GUI-FDE could not start. Cause: ${cliErrorMessage(error)}`);
  }
}

function parseFdeLaunch(
  argv: readonly string[],
):
  | { readonly ok: true; readonly rootDir: string; readonly browser: boolean; readonly port?: number }
  | { readonly ok: false; readonly code: string; readonly hint: string } {
  let root: string | undefined;
  let port: number | undefined;
  let browser = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "fde" || value === "--json") continue;
    if (value === "--browser") {
      browser = true;
      continue;
    }
    if (value === "--port") {
      const supplied = argv[index + 1];
      if (!supplied || supplied.startsWith("-")) {
        return { ok: false, code: "missing_field", hint: "Add a TCP port number after --port." };
      }
      const parsed = Number(supplied);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return { ok: false, code: "invalid_field", hint: "--port must be an integer between 0 and 65535." };
      }
      port = parsed;
      index += 1;
      continue;
    }
    if (value === "--root") {
      const supplied = argv[index + 1];
      if (!supplied || supplied.startsWith("-")) {
        return { ok: false, code: "missing_field", hint: "Add a workspace path after --root." };
      }
      if (root !== undefined) {
        return { ok: false, code: "invalid_field", hint: "Pass --root at most once to ha fde." };
      }
      root = supplied;
      index += 1;
      continue;
    }
    return {
      ok: false,
      code: "unsupported_command",
      hint: "Use `ha fde [--browser [--port <n>]] [--root <path>]`.",
    };
  }
  if (port !== undefined && !browser) {
    return { ok: false, code: "invalid_field", hint: "--port requires --browser." };
  }
  return { ok: true, rootDir: path.resolve(root ?? process.cwd()), browser, ...(port !== undefined ? { port } : {}) };
}

function resolveFdePackageRoot(): string | undefined {
  try {
    const packageName = ["@harness-anything", "gui-fde", "package.json"].join("/");
    const manifest = createRequire(import.meta.url).resolve(packageName);
    return path.dirname(manifest);
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
}

async function startFdeBrowserServer(options: {
  readonly fdePackageRoot: string;
  readonly rootDir: string;
  readonly port?: number;
}): Promise<FdeBrowserServerHandle> {
  const builtServer = path.join(options.fdePackageRoot, "dist-electron/fde-server.js");
  const sourceServer = path.join(options.fdePackageRoot, "src/server/fde-server.ts");
  const serverModulePath = existsSync(builtServer) ? builtServer : sourceServer;
  const mod = (await import(pathToFileURL(serverModulePath).href)) as {
    readonly startFdeStudioServer: (input: {
      readonly rootDir: string;
      readonly distDir: string;
      readonly port?: number;
    }) => Promise<FdeBrowserServerHandle>;
  };
  return mod.startFdeStudioServer({
    rootDir: options.rootDir,
    distDir: path.join(options.fdePackageRoot, "dist"),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
}

function waitForBrowserClose(server: FdeBrowserServerHandle): Promise<void> {
  return new Promise((resolve) => {
    const close = () => void server.close().finally(resolve);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function resolveFdeElectronRuntime(fdePackageRoot: string): FdeElectronRuntime {
  let electronRoot: string;
  try {
    electronRoot = path.dirname(
      createRequire(path.join(fdePackageRoot, "package.json")).resolve("electron/package.json"),
    );
  } catch (error) {
    consumeKnownError(error);
    return {
      remedy:
        "The Electron runtime package is not installed beside @harness-anything/gui-fde. Run `npm install`, then retry `ha fde`.",
    };
  }
  const installScript = path.join(electronRoot, "install.js");
  const remedy = `The Electron runtime was not downloaded. Run \`node ${installScript}\`, then retry \`ha fde\`.`;
  try {
    const relativeBinary = readFileSync(path.join(electronRoot, "path.txt"), "utf8").trim();
    if (!relativeBinary) return { installScript, remedy };
    const candidate = path.resolve(electronRoot, "dist", relativeBinary);
    accessSync(candidate, constants.F_OK | constants.X_OK);
    return { binary: candidate, installScript, remedy };
  } catch (error) {
    consumeKnownError(error);
    return { installScript, remedy };
  }
}

async function launchDesktopFde(context: {
  readonly rootDir: string;
  readonly fdePackageRoot: string;
  readonly mainBundle: string;
  readonly electronRuntime: FdeElectronRuntime;
  readonly logPath: string;
  readonly dependencies: FdeLaunchDependencies;
  readonly finish: (receipt: Record<string, unknown>, exitCode: number) => number;
  readonly reject: (errorCode: string, hint: string, exitCode?: number) => number;
}): Promise<number> {
  const channel = await startReadinessChannel();
  try {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HARNESS_FDE_ROOT: context.rootDir,
      HARNESS_FDE_LAUNCH_ADDR: channel.addr,
      HARNESS_FDE_LAUNCH_TOKEN: channel.token,
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = (context.dependencies.startDetached ?? startDetachedProcess)(
      context.electronRuntime.binary!,
      [context.mainBundle],
      environment,
      context.logPath,
      context.fdePackageRoot,
      false,
    );
    child.on?.("error", consumeKnownError);
    if (child.pid === undefined) {
      return context.reject("fde_launch_failed", `Electron at ${context.electronRuntime.binary} could not be started.`);
    }
    const signal = context.dependencies.waitForReady
      ? await context.dependencies.waitForReady({
          child,
          logPath: context.logPath,
          addr: channel.addr,
          token: channel.token,
        })
      : await awaitReadiness(child, channel);
    if (!signal.ok) {
      return context.reject("fde_launch_failed", signal.detail ?? signal.reason ?? "GUI-FDE failed to become ready.");
    }
    const activePid = signal.pid ?? child.pid;
    return context.finish(
      {
        ok: true,
        command: "fde",
        mode: signal.mode ?? "desktop",
        pid: activePid,
        log: context.logPath,
        rootDir: context.rootDir,
        summary: `Harness Anything GUI-FDE launched (pid ${activePid}) for ${context.rootDir}; logs: ${context.logPath}`,
      },
      0,
    );
  } finally {
    channel.close();
  }
}

interface ReadinessChannel {
  readonly addr: string;
  readonly token: string;
  readonly signalPromise: Promise<FdeLaunchReadinessSignal>;
  close(): void;
}

async function startReadinessChannel(): Promise<ReadinessChannel> {
  const token = randomBytes(16).toString("hex");
  let resolveSignal: ((signal: FdeLaunchReadinessSignal) => void) | null = null;
  const signalPromise = new Promise<FdeLaunchReadinessSignal>((resolve) => {
    resolveSignal = resolve;
  });
  let settled = false;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        if (parsed.token !== token || typeof parsed.ok !== "boolean") {
          socket.destroy();
          return;
        }
        socket.end("ack\n");
        if (!settled) {
          settled = true;
          resolveSignal?.({
            ok: parsed.ok,
            ...(typeof parsed.mode === "string" ? { mode: parsed.mode } : {}),
            ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
            ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
            ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
          });
        }
      } catch (error) {
        consumeKnownError(error);
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not bind GUI-FDE launch readiness socket.");
  }
  return {
    addr: `${LOOPBACK_HOST}:${address.port}`,
    token,
    signalPromise,
    close: () => server.close(),
  };
}

function awaitReadiness(
  child: ReturnType<typeof startDetachedProcess>,
  channel: ReadinessChannel,
): Promise<FdeLaunchReadinessSignal> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (signal: FdeLaunchReadinessSignal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(signal);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "fde_launch_timeout", detail: "Timed out waiting for GUI-FDE readiness." });
    }, FDE_LAUNCH_TIMEOUT_MS);
    timer.unref?.();
    child.once?.("error", (error: Error) => finish({ ok: false, reason: "fde_launch_failed", detail: error.message }));
    child.once?.("exit", (code: number | null) =>
      finish({ ok: false, reason: "fde_process_exited", detail: `Electron exited with code ${code ?? "unknown"}.` }),
    );
    void channel.signalPromise.then(finish);
  });
}
