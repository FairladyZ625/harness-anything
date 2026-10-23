import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
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
    ...(f.booleans.has("--as-owner") ? { asOwner: true } : {}),
  });
}

export function parseTaskAttest(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const taskId = args[2];
  if (!nonEmpty(taskId)) return rejected("missing_field", "Run ha task attest <task-id>.", json);
  const f = readFlags("task-attest", args.slice(3), inputs);
  return f.ok
    ? accepted(rootDir, repoId, json, {
        kind: "task-attest",
        taskId,
        gateId: f.one.get("--gate"),
        result: f.one.get("--result"),
        ...(f.one.get("--mode") ? { mode: f.one.get("--mode") } : {}),
        ...(f.one.get("--note") ? { note: f.one.get("--note") } : {}),
        ...(f.one.get("--rationale") !== undefined ? { rationale: f.one.get("--rationale") } : {}),
      })
    : rejected(f.code, f.nextAction, json);
}
