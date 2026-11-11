import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { readFile } from "node:fs/promises";
import { ensureProbeDirectory, writeProbeFile } from "@harness-anything/daemon/internal/probe-log-sink";
import { JS_STACK_METHOD_ALLOWLIST } from "./probe-options.ts";
import { openProbeRpc } from "./probe-rpc.ts";
import { runProbeCommand } from "./process-port.ts";
import type { TriggerReason } from "./probe-trigger.ts";

// One capture per event: the caller owns the trigger/cooldown state; this module only records the
// scene. Everything it runs is read-only — `sample` is the one tool the task explicitly allows.
export interface CaptureRequest {
  readonly pid: number;
  readonly reason: TriggerReason;
  readonly at: number;
  readonly dir: string;
  readonly socketPath: string;
  readonly jsStackMethod: string;
  readonly jsStackTimeoutMs: number;
  readonly sampleSeconds: number;
}

export type JsStackStatus = OperationalStatus.JsStackStatus;

export interface JsStackResult {
  readonly method: string;
  readonly status: JsStackStatus;
  readonly file: string | null;
  readonly detail: string | null;
}

export interface CaptureResult {
  readonly captured: boolean;
  readonly files: readonly string[];
  readonly errors: readonly string[];
  readonly jsStack: JsStackResult;
}

export interface CapturePort {
  readonly capture: (request: CaptureRequest) => Promise<CaptureResult>;
}

export interface CaptureOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: typeof runProbeCommand;
  readonly readFileText?: (file: string) => Promise<string>;
  readonly writeCaptureFile?: (dir: string, name: string, body: string) => Promise<string>;
  readonly ensureDirectory?: (dir: string) => Promise<void>;
  readonly jsStackProbe?: (
    socketPath: string,
    method: string,
    timeoutMs: number,
    dir: string,
  ) => Promise<JsStackResult>;
}

export function createCapturePort(options: CaptureOptions = {}): CapturePort {
  const platform = options.platform ?? process.platform,
    run = options.runCommand ?? runProbeCommand,
    readText = options.readFileText ?? ((file: string) => readFile(file, "utf8")),
    writeCapture = options.writeCaptureFile ?? writeProbeFile,
    ensureDirectory = options.ensureDirectory ?? ensureProbeDirectory,
    jsStackProbe = options.jsStackProbe ?? probeJsStack;
  return {
    capture: async (request) => {
      const files: string[] = [],
        errors: string[] = [],
        stamp = new Date(request.at).toISOString().replace(/[-:.]/gu, "");
      let captured = false;
      await ensureDirectory(request.dir);
      if (platform === "darwin") {
        const name = `${stamp}-${request.reason}.sample.txt`,
          file = `${request.dir}/${name}`,
          result = await run(
            "sample",
            [String(request.pid), String(request.sampleSeconds), "-file", file],
            15_000 + request.sampleSeconds * 1000,
          );
        if (result.error !== null || result.exitCode !== 0) {
          const body = `sample failed for pid ${request.pid}: ${result.error ?? `exit ${String(result.exitCode)}`}\n${result.stderr}`;
          files.push(await writeCapture(request.dir, `${name}.error.txt`, body));
          errors.push(body.trim());
        } else {
          files.push(file);
          captured = true;
        }
      } else if (platform === "linux") {
        const dump = await linuxProcDump(request.pid, readText);
        files.push(await writeCapture(request.dir, `${stamp}-${request.reason}.proc.txt`, dump.body));
        captured = dump.hasContent;
        if (!captured) errors.push("no readable /proc diagnostic content");
      } else {
        files.push(
          await writeCapture(
            request.dir,
            `${stamp}-${request.reason}.unsupported.txt`,
            `No read-only capture tool is implemented for platform ${platform}; daemon pid=${request.pid}.\n`,
          ),
        );
      }
      const jsStack = await jsStackProbe(
        request.socketPath,
        request.jsStackMethod,
        request.jsStackTimeoutMs,
        request.dir,
      );
      if (jsStack.file !== null) files.push(jsStack.file);
      captured ||= jsStack.status === "captured" && jsStack.file !== null;
      if (jsStack.detail !== null && jsStack.status !== "captured") errors.push(`js stack: ${jsStack.detail}`);
      return { captured, files, errors, jsStack };
    },
  };
}

async function linuxProcDump(
  pid: number,
  readText: (file: string) => Promise<string>,
): Promise<{ readonly body: string; readonly hasContent: boolean }> {
  const paths = ["status", "stack", "wchan", "syscall", "stat"].map((name) => `/proc/${String(pid)}/${name}`),
    sections: string[] = [`# read-only /proc dump for pid ${String(pid)}`];
  let hasContent = false;
  for (const file of paths) {
    const read = await attemptRead(() => readText(file));
    sections.push(read.ok ? `\n## ${file}\n${read.value}` : `\n## ${file}\nunavailable: ${read.error}`);
    if (read.ok && read.value.trim().length > 0) hasContent = true;
  }
  return { body: `${sections.join("")}\n`, hasContent };
}

// The daemon-side JS stack exporter is owned by another task. The probe never assumes it exists:
// hello's advertised method list is the capability surface, and absence is recorded, not retried.
export async function probeJsStack(
  socketPath: string,
  method: string,
  timeoutMs: number,
  dir: string,
): Promise<JsStackResult> {
  if (!JS_STACK_METHOD_ALLOWLIST.includes(method))
    return {
      method,
      status: "failed",
      file: null,
      detail: `refused non-diagnostic method ${method}; only ${JS_STACK_METHOD_ALLOWLIST.join(", ")} may be called`,
    };
  let rpc;
  try {
    rpc = await openProbeRpc(socketPath, timeoutMs);
  } catch (error) {
    return {
      method,
      status: "unreachable",
      file: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const methods = Array.isArray(rpc.hello.methods) ? rpc.hello.methods : [];
    if (!methods.includes(method))
      return {
        method,
        status: "not-advertised",
        file: null,
        detail: `protocol.hello advertised ${String(methods.length)} methods without ${method}`,
      };
    const result = await rpc.client.request(method, {}, timeoutMs),
      file = await writeProbeFile(
        dir,
        `js-stack-${sanitize(method)}-${String(Date.now())}.json`,
        `${JSON.stringify(result, null, 2)}\n`,
      );
    return {
      method,
      status: result.ok === false ? "failed" : "captured",
      file,
      detail: result.ok === false ? "daemon rejected the stack read" : null,
    };
  } catch (error) {
    return {
      method,
      status: "failed",
      file: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rpc.client.close();
  }
}

async function attemptRead(
  read: () => Promise<string>,
): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
