import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejected } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export const projectedAliases: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "task-list": { "--kind": "workKind", "--parent": "parentTaskId" },
  "relation-list": { "--type": "relationType" },
  "task-review": { "--reviewer": "reviewerId" },
  "fact-search": { "--task": "taskId" },
  "fact-show": { "--task": "taskId", "--id": "factId" },
  "decision-accept": {
    "--rationale": "rationale",
    "--judgment-only": "judgmentOnlyRationale",
  },
  "decision-reject": { "--rationale": "reason" },
  "decision-defer": { "--rationale": "reason" },
  "distill-candidate": { "--task": "taskId", "--input": "inputPath" },
  "distill-promote": {
    "--task": "taskId",
    "--candidate": "candidatePath",
    "--claim": "statement",
    "--id": "factId",
    "--memory-tag": "memoryTags",
    "--observed-at": "observedAt",
  },
  "decision-reckon": { "--task": "taskId" },
});

export function projectedField(commandId: string, name: string): string {
  return (
    projectedAliases[commandId]?.[name] ??
    name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
  );
}

export function projectFlags(
  commandId: string,
  flags: Extract<ReturnType<typeof readFlags>, { readonly ok: true }>,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [name, value] of flags.one) {
    const field = projectedField(commandId, name);
    projected[field] = field === "limit" || field === "ttlMs" ? Number(value) : value;
  }
  for (const [name, values] of flags.many) projected[projectedField(commandId, name)] = values;
  for (const name of flags.booleans) projected[projectedField(commandId, name)] = true;
  return projected;
}

export function parseProjected(
  commandId: string,
  tokens: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
  base: Readonly<Record<string, unknown>> = {},
  defaults: Readonly<Record<string, unknown>> = {},
): ThinParseResult {
  const f = readFlags(commandId, tokens, inputs);
  return f.ok
    ? accepted(rootDir, repoId, json, {
        kind: commandId,
        ...defaults,
        ...base,
        ...projectFlags(commandId, f),
      })
    : rejected(f.code, f.nextAction, json);
}
