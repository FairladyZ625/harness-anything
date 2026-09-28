import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { safePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { runCommandThroughDaemon } from "./daemon/client.ts";

const MAX_OUTPUT_BYTES = 128 * 1024;

export type TaskEvidenceInvocation = {
  readonly taskId: string;
  readonly command: readonly [string, ...string[]];
  readonly rootDir: string;
  readonly repoId?: string;
  readonly json: boolean;
};

export function parseTaskEvidenceInvocation(
  argv: readonly string[],
  cwd = process.cwd(),
): TaskEvidenceInvocation | null {
  const delimiter = argv.indexOf("--");
  if (delimiter < 0) return null;
  const prefix = argv.slice(0, delimiter),
    command = argv.slice(delimiter + 1),
    positional: string[] = [];
  let rootDir = cwd,
    repoId: string | undefined,
    json = false;
  for (let index = 0; index < prefix.length; index += 1) {
    const token = prefix[index];
    if (token === "--root" || token === "--repo") {
      const value = prefix[index + 1];
      if (!value) return null;
      if (token === "--root") rootDir = value;
      else repoId = value;
      index += 1;
    } else if (token === "--json") json = true;
    else positional.push(token!);
  }
  if (
    positional.length !== 4 ||
    positional[0] !== "task" ||
    positional[1] !== "evidence" ||
    positional[2] !== "run" ||
    !positional[3] ||
    !command[0]
  )
    return null;
  return {
    taskId: positional[3],
    command: command as [string, ...string[]],
    rootDir: path.resolve(cwd, rootDir),
    ...(repoId ? { repoId } : {}),
    json,
  };
}

export async function runTaskEvidence(
  invocation: TaskEvidenceInvocation,
  execute: typeof spawnSync = spawnSync,
  publish: typeof runCommandThroughDaemon = runCommandThroughDaemon,
): Promise<JsonObject> {
  const cwd = realpathSync.native(process.cwd()),
    startedAt = new Date().toISOString(),
    result = execute(invocation.command[0], invocation.command.slice(1), {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    }),
    stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0),
    finishedAt = new Date().toISOString(),
    id = randomUUID(),
    destination = `artifacts/evidence/command-${startedAt.replace(/[:.]/gu, "-")}-${id}.json`,
    transcript = {
      schema: "task-command-evidence/v1",
      taskId: invocation.taskId,
      command: invocation.command,
      cwd,
      startedAt,
      finishedAt,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      stdoutBase64: stdout.toString("base64"),
      stderrBase64: stderr.toString("base64"),
    };
  const receipt = await publish({
    rootDir: safePath(invocation.rootDir),
    ...(invocation.repoId ? { repoId: invocation.repoId } : {}),
    json: invocation.json,
    method: "repo.task.run",
    action: {
      kind: "task-artifact-add",
      taskId: invocation.taskId,
      content: `${JSON.stringify(transcript, null, 2)}\n`,
      destination,
    },
  });
  if (receipt.ok !== true) return receipt;
  return {
    ...receipt,
    command: "task-evidence-run",
    evidencePath: receipt.destination ?? destination,
    childExitCode: result.status,
    childSignal: result.signal,
    exitCode: result.status ?? 1,
    summary: `recorded command evidence at ${String(receipt.destination ?? destination)} (exit ${String(result.status)})`,
  };
}
