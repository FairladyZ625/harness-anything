import taskFrontmatterJsonSchema from "../../schemas/json/task-frontmatter.schema.json" with { type: "json" };
import decisionPackageJsonSchema from "../../schemas/json/decision-package.schema.json" with { type: "json" };
import factEventJsonSchema from "../../schemas/json/fact-event.schema.json" with { type: "json" };
import { requireEntityTypeContract } from "./base-entity.ts";
import {
  type EntityDocumentJsonSchema,
  type EntityJsonObjectSchema,
  type EntityJsonSchemaNode,
} from "./entity-json-schema.ts";

/**
 * Explainable document JSON schemas for the lifecycle entity kinds. These are
 * data, not behavior: the registry consumes them as the `schema` half of each
 * kind contract, and nothing here depends on the catalog or contract tables.
 */
const executionIdPattern = requireEntityTypeContract("execution").id.pattern;
const reviewIdPattern = requireEntityTypeContract("review").id.pattern;
const lifecycleTaskIdPattern = requireEntityTypeContract("task").id.pattern;
const opaqueObject = (): EntityJsonObjectSchema => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
});
const nullableOpaqueObject = (): EntityJsonSchemaNode => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
  "x-nullable": true,
});

function explainableSchema(
  id: string,
  source: Readonly<{ required?: readonly string[]; properties?: Readonly<Record<string, unknown>> }>,
): EntityDocumentJsonSchema {
  const properties = Object.fromEntries(
    Object.entries(source.properties ?? {}).map(([name, node]) => [name, explainableNode(node)]),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    properties,
    required: source.required ?? [],
    additionalProperties: false,
  };
}

function explainableNode(value: unknown): EntityJsonSchemaNode {
  const node = typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
  const description = typeof node.description === "string" ? node.description : undefined;
  const inferred =
    typeof node.type === "string"
      ? node.type
      : typeof node.const === "string"
        ? "string"
        : typeof node.const === "number"
          ? "number"
          : typeof node.const === "boolean"
            ? "boolean"
            : "object";
  if (inferred === "string") return { type: "string", ...(description ? { description } : {}) };
  if (inferred === "number" || inferred === "integer" || inferred === "boolean" || inferred === "null")
    return { type: inferred, ...(description ? { description } : {}) };
  if (inferred === "array") return { type: "array", items: opaqueObject(), ...(description ? { description } : {}) };
  return { ...opaqueObject(), ...(description ? { description } : {}) };
}

export const taskSchema = explainableSchema("task-frontmatter", taskFrontmatterJsonSchema);
export const factSchema = explainableSchema("fact-event", factEventJsonSchema);
export const decisionSchema = explainableSchema("decision-package", decisionPackageJsonSchema);
export const executionSchema: EntityDocumentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Execution/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "execution/v1" },
    executionId: { type: "string", pattern: executionIdPattern, minLength: 1 },
    taskId: { type: "string", pattern: lifecycleTaskIdPattern, minLength: 1 },
    nodeId: { type: "string", const: "implementation" },
    iteration: { type: "integer" },
    state: { type: "string", enum: ["active", "submitted", "accepted", "changes_requested", "abandoned"] },
    actor: opaqueObject(),
    claimedAt: { type: "string", minLength: 1 },
    submittedAt: { type: "string", minLength: 1, "x-nullable": true },
    closedAt: { type: "string", minLength: 1, "x-nullable": true },
    submission: nullableOpaqueObject(),
  },
  required: [
    "schema",
    "executionId",
    "taskId",
    "nodeId",
    "iteration",
    "state",
    "actor",
    "claimedAt",
    "submittedAt",
    "closedAt",
    "submission",
  ],
  additionalProperties: false,
};
export const reviewSchema: EntityDocumentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Review/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "review/v1" },
    reviewId: { type: "string", pattern: reviewIdPattern, minLength: 1 },
    taskId: { type: "string", pattern: lifecycleTaskIdPattern, minLength: 1 },
    executionId: { type: "string", pattern: executionIdPattern, minLength: 1 },
    verdict: { type: "string", enum: ["approved", "changes_requested", "dismissed"] },
    actor: opaqueObject(),
    capabilityRef: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    evidenceChecked: { type: "array", items: { type: "string", minLength: 1 } },
    commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    iteration: { type: "integer" },
    contentDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    submissionDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    reviewedAt: { type: "string", minLength: 1 },
  },
  required: [
    "schema",
    "reviewId",
    "taskId",
    "executionId",
    "verdict",
    "actor",
    "capabilityRef",
    "reason",
    "evidenceChecked",
    "commitSha",
    "iteration",
    "contentDigest",
    "reviewedAt",
  ],
  additionalProperties: false,
};
