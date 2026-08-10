import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_SCHEMA_VERSION = "coldstart-eval-run/v1";
export const RUNNER_VERSION = "1.0.0";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
export const runSchemaPath = path.join(moduleRoot, "run.schema.json");

export function loadRunSchema() {
  return JSON.parse(readFileSync(runSchemaPath, "utf8"));
}

export function validateRunRecord(value) {
  const schema = loadRunSchema();
  const errors = [];
  validateNode(schema, value, "$", schema, errors);
  validateSemantics(value, errors);
  return { ok: errors.length === 0, errors };
}

export function assertValidRunRecord(value) {
  const result = validateRunRecord(value);
  if (!result.ok) throw new Error(`cold-start run validation failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
  return value;
}

function validateNode(schema, value, location, root, errors) {
  if (schema.$ref) {
    validateNode(resolveReference(root, schema.$ref), value, location, root, errors);
    return;
  }

  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    errors.push(`${location}: expected constant ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${location}: expected one of ${schema.enum.map(JSON.stringify).join(", ")}`);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${location}: expected type ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`);
    return;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location}: string is shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${location}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !isIsoDateTime(value)) errors.push(`${location}: expected an ISO date-time`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location}: must be <= ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location}: expected at least ${schema.minItems} items`);
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) errors.push(`${location}: items must be unique`);
    }
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${location}[${index}]`, root, errors));
  }

  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}: required property is missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${location}.${key}: additional property is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateNode(childSchema, value[key], `${location}.${key}`, root, errors);
    }
  }
}

function validateSemantics(run, errors) {
  if (!isObject(run)) return;
  if (run.schemaVersion !== run.provenance?.schema?.version) errors.push("$.provenance.schema.version: must equal schemaVersion");
  if (run.status !== run.reconciliation?.status) errors.push("$.status: must equal reconciliation.status");
  if (run.reconciliation?.runtimeEventsUsedForVerdict !== false) errors.push("$.reconciliation.runtimeEventsUsedForVerdict: runtime events are ancillary only");

  for (const [name, rate] of Object.entries({
    invocationRate: run.metrics?.invocationRate,
    firstAttemptCorrectRate: run.metrics?.firstAttemptCorrectRate,
    postInvocationSuccessRate: run.metrics?.postInvocationSuccessRate,
    driverVerificationCompletionRate: run.metrics?.driverVerificationCompletionRate
  })) {
    if (!isObject(rate) || typeof rate.numerator !== "number" || typeof rate.denominator !== "number" || typeof rate.value !== "number") continue;
    if (rate.numerator > rate.denominator) errors.push(`$.metrics.${name}.numerator: must not exceed denominator`);
    if (Math.abs(rate.value - rate.numerator / rate.denominator) > 1e-12) errors.push(`$.metrics.${name}.value: must equal numerator / denominator`);
  }

  const bypass = run.metrics?.bypassRate;
  if (isObject(bypass) && typeof bypass.events === "number" && typeof bypass.totalActions === "number" && typeof bypass.rate === "number") {
    if (bypass.events > bypass.totalActions) errors.push("$.metrics.bypassRate.events: must not exceed totalActions");
    if (Math.abs(bypass.rate - bypass.events / bypass.totalActions) > 1e-12) errors.push("$.metrics.bypassRate.rate: must equal events / totalActions");
  }
  const alternative = run.metrics?.alternativePathShare;
  if (isObject(alternative) && typeof alternative.alternativeActions === "number" && typeof alternative.eligiblePathActions === "number" && typeof alternative.rate === "number") {
    if (alternative.alternativeActions > alternative.eligiblePathActions) errors.push("$.metrics.alternativePathShare.alternativeActions: must not exceed eligiblePathActions");
    if (Math.abs(alternative.rate - alternative.alternativeActions / alternative.eligiblePathActions) > 1e-12) errors.push("$.metrics.alternativePathShare.rate: must equal alternativeActions / eligiblePathActions");
  }

  const applicable = run.scenario?.commandOpportunities?.filter?.((row) => row.applicable) ?? [];
  const invoked = applicable.filter((row) => row.invoked);
  if (run.metrics?.commandOpportunitySet?.applicable !== applicable.length) errors.push("$.metrics.commandOpportunitySet.applicable: must match the scenario opportunity set");
  if (run.metrics?.commandOpportunitySet?.invoked !== invoked.length) errors.push("$.metrics.commandOpportunitySet.invoked: must match invoked scenario opportunities");

  const requiredChannels = Object.values(run.evidence ?? {}).filter((channel) => isObject(channel) && channel.required === true);
  const missingRequired = requiredChannels.some((channel) => channel.status !== "present");
  if (run.status === "complete" && missingRequired) errors.push("$.status: complete requires every required evidence channel to be present");
  if (run.status === "incomplete" && (run.reconciliation?.issues?.length ?? 0) === 0) errors.push("$.reconciliation.issues: incomplete runs must explain the missing evidence");
  if (run.status === "incomplete" && run.outcome !== "unknown") errors.push("$.outcome: incomplete runs must use unknown");
  if (run.status === "complete" && run.outcome !== run.reconciliation?.productOutcome) errors.push("$.outcome: complete runs must use the reconciled product outcome");

  const expectedValidity = run.status === "complete"
    && run.contamination?.status === "clean"
    && run.subject?.actionLogComplete === true
    && run.environment?.workspaceEvaluatorFilesPresent === false
    && (run.environment?.cleanup?.errors?.length ?? 1) === 0
      ? "valid"
      : "invalid";
  if (run.validity?.status !== expectedValidity) errors.push(`$.validity.status: expected ${expectedValidity} from completeness, contamination, log coverage, workspace, and cleanup`);

  const contaminated = (run.contamination?.accessedEvaluatorFiles?.length ?? 0) > 0
    || run.contamination?.evaluatorFilesPresentInWorkspace === true;
  if ((run.contamination?.status === "contaminated") !== contaminated) errors.push("$.contamination.status: must reflect evaluator presence or access evidence");

  if (run.control?.kind === "primary" && (run.control.sourceRunId !== null || run.control.omittedChannel !== null)) {
    errors.push("$.control: primary runs must not name a source run or omitted channel");
  }
  if (run.control?.kind === "missing-channel-negative" && (!run.control.sourceRunId || !run.control.omittedChannel)) {
    errors.push("$.control: negative controls must name their source run and omitted channel");
  }
}

function resolveReference(root, reference) {
  if (!reference.startsWith("#/")) throw new Error(`unsupported JSON Schema reference: ${reference}`);
  return reference.slice(2).split("/").reduce((value, segment) => value[segment.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return isObject(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && !Number.isNaN(Date.parse(value));
}
