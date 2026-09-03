import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export const projectedAliases: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "task-list": { "--kind": "workKind", "--parent": "parentTaskId" },
  "relation-list": { "--type": "relationType" },
  "task-review": { "--reviewer": "reviewerId" },
  "fact-search": { "--task": "taskId", "--type": "domainType" },
  "fact-show": { "--id": "factId" },
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
  inputs?: ThinCliInputDirectory,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [name, value] of flags.one) {
    const input = inputs?.get(commandId)?.inputs.find((candidate) => candidate.name === name),
      field = input?.field ?? projectedField(commandId, name);
    projected[field] = input?.projection === "number" || field === "limit" || field === "ttlMs" ? Number(value) : value;
  }
  for (const [name, values] of flags.many) {
    const input = inputs?.get(commandId)?.inputs.find((candidate) => candidate.name === name),
      field = input?.field ?? projectedField(commandId, name);
    projected[field] =
      input?.projection === "fact-hold-array"
        ? values.map((value) => {
            const separator = value.indexOf(":"),
              suppliedRef = value.slice(0, separator);
            return {
              factRef: suppliedRef.startsWith("fact/") ? suppliedRef : `fact/${suppliedRef}`,
              rationale: value.slice(separator + 1),
            };
          })
        : values;
  }
  for (const name of flags.booleans) {
    const input = inputs?.get(commandId)?.inputs.find((candidate) => candidate.name === name);
    projected[input?.field ?? projectedField(commandId, name)] = true;
  }
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
  method?: string,
): ThinParseResult {
  const f = readFlags(commandId, tokens, inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const declaration = inputs.get(commandId),
    action: Record<string, unknown> = {
      kind: commandId,
      ...(declaration?.actionDefaults ?? {}),
      ...defaults,
      ...base,
      ...projectFlags(commandId, f, inputs),
    },
    conditionalViolation = declaration?.inputs.find((input) => {
      const field = input.field ?? projectedField(commandId, input.name),
        present = action[field] !== undefined,
        matches = (condition: NonNullable<typeof input.requiredWhen>) =>
          condition.values.includes(String(action[condition.field]));
      return (
        (input.requiredWhen !== undefined && matches(input.requiredWhen) && !present) ||
        (input.allowedWhen !== undefined && present && !matches(input.allowedWhen))
      );
    }),
    invalidGroup = declaration?.actionConstraints?.find(
      (group) => group.filter((field) => action[field] !== undefined).length !== 1,
    );
  if (conditionalViolation) return rejectInput(inputs, commandId, conditionalViolation.name, json);
  if (invalidGroup) {
    const input = declaration?.inputs.find((candidate) => invalidGroup.includes(candidate.field ?? ""));
    return rejectInput(inputs, commandId, input?.name ?? invalidGroup[0] ?? "input", json);
  }
  return accepted(rootDir, repoId, json, action as { readonly kind: string }, method);
}
