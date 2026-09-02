import { deriveUseCaseProjectionInputs, type UseCaseProjectionName } from "../../../kernel/src/index.ts";
import { validateAgentRuntimeSessionGroups } from "../agent-runtime-contract.ts";
import { validateScheduleRuns } from "../schedule-runs-read.ts";
import { isJsonObject } from "./json-rpc-types.ts";
import { validationError } from "./daemon-protocol-validate-entities.ts";
import {
  isUseCaseProjectionFacet,
  isUseCaseProjectionName,
  useCaseProjectionFacets,
  useCaseProjectionSchemaId,
  type DaemonUseCaseProjectionResult,
} from "./daemon-protocol-gui-types.ts";
import { validateSchedulesList } from "./schedules-gui-contract.ts";

/**
 * Result-side validation for the use-case projection envelope. This half is deliberately *not* on
 * the daemon transport path: it resolves the projection's inputs from the kernel kind registry, so
 * an envelope that hand-restates its own inputs is rejected instead of trusted.
 */

type ProjectionValidator = (value: unknown) => readonly string[];

/**
 * Inner-shape validators, reused verbatim from the reads this projection replaced. The shapes are
 * unchanged on the wire — CH4 says the boundary is authority and visibility, not field renaming —
 * so the same validator that guarded `repo.schedules.list` now guards `schedule-plane/plane`.
 */
const innerValidators: Readonly<Record<string, ProjectionValidator>> = Object.freeze({
  "schedule-plane/plane": validateSchedulesList,
  "schedule-run-history/runs": validateScheduleRuns,
  "runtime-session-groups/groups": validateAgentRuntimeSessionGroups,
});

export function validateDaemonUseCaseProjection(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return [validationError("use-case-projection", "result", value, "must be an object")];
  const allowed = ["schema", "ok", "name", "facet", "version", "inputs", "projection"];
  const unexpected = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unexpected.length > 0)
    return [validationError("use-case-projection", "result", unexpected.sort().join(", "), "has unexpected fields")];
  if (value.schema !== useCaseProjectionSchemaId)
    return [validationError("use-case-projection", "schema", value.schema, `must be ${useCaseProjectionSchemaId}`)];
  if (value.ok !== true) return [validationError("use-case-projection", "ok", value.ok, "must be true")];
  if (!isUseCaseProjectionName(value.name))
    return [validationError("use-case-projection", "name", value.name, "must be a catalog projection name")];
  if (!isUseCaseProjectionFacet(value.name, value.facet))
    return [
      validationError(
        "use-case-projection",
        "facet",
        value.facet,
        `must be one of ${useCaseProjectionFacets[value.name].join(", ")}`,
      ),
    ];
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1)
    return [validationError("use-case-projection", "version", value.version, "must be a positive integer")];
  const inputErrors = inputsInvalid(value.name, value.inputs);
  if (inputErrors.length > 0) return inputErrors;
  const inner = innerValidators[`${value.name}/${value.facet}`];
  if (!inner)
    return [
      validationError("use-case-projection", "projection", `${value.name}/${value.facet}`, "has no inner validator"),
    ];
  return inner(value.projection);
}

function inputsInvalid(name: UseCaseProjectionName, value: unknown): readonly string[] {
  const expected = deriveUseCaseProjectionInputs(name);
  if (!isJsonObject(value) || Object.keys(value).length !== 2)
    return [validationError("use-case-projection", "inputs", value, "must declare entityKinds and relationTypes")];
  const kinds = value.entityKinds,
    relations = value.relationTypes;
  const same = (actual: unknown, want: readonly string[]) =>
    Array.isArray(actual) && actual.length === want.length && want.every((item, index) => actual[index] === item);
  if (!same(kinds, expected.entityKinds))
    return [
      validationError(
        "use-case-projection",
        "inputs.entityKinds",
        kinds,
        `must equal ${expected.entityKinds.join(", ")}`,
      ),
    ];
  if (!same(relations, expected.relationTypes))
    return [
      validationError(
        "use-case-projection",
        "inputs.relationTypes",
        relations,
        `must equal the kinds' registered relation types (${expected.relationTypes.join(", ") || "none"})`,
      ),
    ];
  return [];
}

export function serializeDaemonUseCaseProjection(value: DaemonUseCaseProjectionResult): string {
  const errors = validateDaemonUseCaseProjection(value);
  if (errors.length) throw new Error(errors.join("; "));
  return JSON.stringify(value);
}
