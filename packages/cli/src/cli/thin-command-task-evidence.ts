import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  readFlags,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseProgress(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  args: readonly string[],
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const taskId = args[3],
    f = readFlags("task-progress-append", args.slice(4), inputs);
  if (!nonEmpty(taskId))
    return rejected(
      "missing_field",
      "Run ha task progress append <task-id>.",
      json,
    );
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const evidence = (f.many.get("--evidence") ?? []).map((value) => {
    const first = value.indexOf(":"),
      second = value.indexOf(":", first + 1);
    return {
      type: value.slice(0, first),
      path: value.slice(first + 1, second),
      summary: value.slice(second + 1),
    };
  });
  return accepted(rootDir, repoId, json, {
    kind: "task-progress-append",
    taskId,
    text: f.one.get("--text"),
    evidence,
  });
}

export function parseCodeDoc(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  args: readonly string[],
  taskId: string,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("task-code-doc-reconcile", args.slice(4), inputs);
  return f.ok
    ? accepted(rootDir, repoId, json, {
        kind: "task-code-doc-reconcile",
        taskId,
        executionId: f.one.get("--execution-id"),
        commitSha: f.one.get("--commit-sha"),
        iteration: Number(f.one.get("--iteration")),
        paths: f.many.get("--path") ?? [],
      })
    : rejected(f.code, f.nextAction, json);
}

export function parseComplete(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  args: readonly string[],
  taskId: string,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("task-complete", args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const executionId = f.one.get("--execution-id"),
    paths = f.many.get("--path") ?? [];
  return accepted(rootDir, repoId, json, {
    kind: "task-complete",
    verb: args[1],
    commandType: "CompleteTask",
    taskId,
    ...(executionId ? { executionId } : {}),
    ...(f.one.get("--ci") ? { ci: f.one.get("--ci") } : {}),
    ...(paths.length ? { paths } : {}),
  });
}
