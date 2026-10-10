import Ajv from "ajv";
import type { ArtifactDelivery } from "../domain/execution.ts";
import type { FrozenGateRequirement } from "../domain/completion-contract.ts";
import type { CompletionWitnessResult } from "../domain/gate-run.ts";
import { stableStringify } from "../integrity/stable-hash.ts";

const predicates = new Ajv({ allErrors: true, strictKeywords: true, jsonPointers: true });
/** Judge new runner output against the accepted source and input cut, not the current workspace. */
export function completionPredicateIssues(
  requirement: FrozenGateRequirement,
  result: CompletionWitnessResult,
  subjects: readonly ArtifactDelivery[],
  readArtifact: (logicalPath: string) => unknown,
): readonly string[] {
  const prefix = `gates.${requirement.gateId}.predicate`,
    source = requirement.witness;
  if (source.kind === "internal" || source.kind === "historical")
    return ["This requirement does not admit a source result."];
  if (result.predicateType !== source.predicateType)
    return [`gates.${requirement.gateId}.predicateType does not match the frozen source`];
  const ordered = (values: readonly ArtifactDelivery[]) => [...values].sort((a, b) => a.path.localeCompare(b.path));
  if (stableStringify(ordered(result.subjects)) !== stableStringify(ordered(subjects)))
    return [`gates.${requirement.gateId}.subjects must cover exactly the frozen subject identities`];
  const validate = predicates.compile(source.resultSchema),
    issues: string[] = [];
  if (!validate(result.predicate))
    for (const error of validate.errors ?? []) {
      const field =
          error.keyword === "required" ? String((error.params as { missingProperty: string }).missingProperty) : "",
        pointer = error.dataPath
          .split("/")
          .filter(Boolean)
          .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      issues.push(`${[prefix, ...pointer, ...(field ? [field] : [])].join(".")}: ${error.message}`);
    }
  for (const [field, binding] of Object.entries(requirement.bindings ?? {})) {
    let expected: unknown = readArtifact(binding.artifact);
    for (const token of binding.pointer === "" ? [] : binding.pointer.slice(1).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      expected =
        expected !== null && typeof expected === "object" && Object.hasOwn(expected, key)
          ? (expected as Readonly<Record<string, unknown>>)[key]
          : undefined;
    }
    if (expected === undefined) issues.push(`${prefix}.${field}: missing ${binding.artifact}${binding.pointer}`);
    else if (stableStringify(result.predicate[field]) !== stableStringify(expected))
      issues.push(`${prefix}.${field}: does not equal ${binding.artifact}${binding.pointer}`);
  }
  return issues;
}
