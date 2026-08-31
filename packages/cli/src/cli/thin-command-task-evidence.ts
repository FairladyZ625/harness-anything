import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseProgress(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  args: readonly string[],
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const taskId = args[3],
    tokens = args.slice(4),
    renamed = tokens
      .map((token) => token.split("=", 1)[0])
      .find((token) => token === "--note" || token === "--evidence-source");
  if (!nonEmpty(taskId)) return rejected("missing_field", "Run ha task progress append <task-id>.", json);
  if (renamed === "--note") return rejected("unknown_field", "--note was removed. Use --text <progress-text>.", json);
  if (renamed === "--evidence-source")
    return rejected("unknown_field", "--evidence-source was removed. Use --evidence <type>:<path>:<summary>.", json);
  const f = readFlags("task-progress-append", tokens, inputs);
  if (!f.ok)
    return rejected(
      f.code,
      f.offendingValue === undefined ? f.nextAction : `${f.nextAction} Received ${JSON.stringify(f.offendingValue)}.`,
      json,
    );
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
        paths: f.many.get("--path") ?? [],
      })
    : rejected(
        f.code,
        `Run ha task code-doc reconcile ${taskId} --path <completion-code-doc-path>; ` +
          "the submitted execution supplies execution id, commit, and iteration. " +
          "See ha task code-doc reconcile --help.",
        json,
      );
}

export function parseCodeDocRepoint(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  args: readonly string[],
  taskId: string,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (args.slice(4).some((token) => token.split("=", 1)[0] === "--commit-sha"))
    return rejected(
      "unknown_field",
      `Run ha task code-doc repoint ${taskId} without --commit-sha; ` +
        "the submitted execution supplies the witness cut. See ha task code-doc repoint --help.",
      json,
    );
  const f = readFlags("task-code-doc-repoint", args.slice(4), inputs);
  return f.ok
    ? accepted(rootDir, repoId, json, {
        kind: "task-code-doc-repoint",
        taskId,
        record: f.one.get("--record"),
        paths: f.many.get("--path") ?? [],
        reason: f.one.get("--reason"),
      })
    : rejected(f.code, f.nextAction, json);
}
