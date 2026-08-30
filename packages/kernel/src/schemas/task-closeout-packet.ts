import type { SubmissionV1 } from "../domain/execution.ts";
import { reviewVerdicts, type ReviewVerdict } from "../domain/review.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";

export const closeoutCiJudgments = ["passed", "not_applicable"] as const;
export type CloseoutCiJudgment = (typeof closeoutCiJudgments)[number];

export interface TaskCloseoutPacket {
  readonly submission?: SubmissionV1;
  readonly review: {
    readonly verdict: ReviewVerdict;
    readonly reason: string;
    readonly evidenceChecked: readonly string[];
  };
  readonly consent: { readonly approved: true };
  readonly completion: {
    readonly ci: CloseoutCiJudgment;
    readonly codeDocPaths: readonly string[];
  };
}

type SchemaNode =
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, SchemaNode>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
      readonly description?: string;
      readonly example?: unknown;
    }
  | {
      readonly type: "array";
      readonly items: SchemaNode;
      readonly minItems?: number;
      readonly description?: string;
      readonly example?: unknown;
    }
  | {
      readonly type: "string";
      readonly minLength?: number;
      readonly pattern?: string;
      readonly format?: "portable-relative-path";
      readonly enum?: readonly string[];
      readonly description?: string;
      readonly example?: unknown;
    }
  | {
      readonly type: "boolean";
      readonly const: boolean;
      readonly description?: string;
      readonly example?: unknown;
    };

const nonEmptyString = (example: string, description: string): SchemaNode => ({
    type: "string",
    minLength: 1,
    example,
    description,
  }),
  stringArray = (example: string, description: string): SchemaNode => ({
    type: "array",
    items: nonEmptyString(example, description),
    example: [example],
    description,
  }),
  portablePath = (example: string, description: string): SchemaNode => ({
    type: "string",
    minLength: 1,
    format: "portable-relative-path",
    example,
    description,
  }),
  portablePathArray = (example: string, description: string): SchemaNode => ({
    type: "array",
    items: portablePath(example, description),
    example: [example],
    description,
  });

/** The single runtime, template, and CLI-help authority for `ha task closeout --from-file`. */
export const taskCloseoutPacketSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "harness://schema/task-closeout-packet/v1",
  title: "Task closeout packet",
  type: "object",
  additionalProperties: false,
  required: ["review", "consent", "completion"],
  properties: {
    submission: {
      type: "object",
      additionalProperties: false,
      required: [
        "completionClaim",
        "deliverables",
        "outputs",
        "verificationNotes",
        "knownGaps",
        "residualRisks",
        "commitSha",
      ],
      description: "Required before submit; omit it to resume an already-submitted Execution.",
      properties: {
        completionClaim: nonEmptyString("Describe the completed outcome.", "Completion claim."),
        deliverables: stringArray(
          "Describe one delivered artifact or repository path.",
          "Delivered artifact descriptions or paths.",
        ),
        outputs: stringArray("Describe one output or evidence reference.", "Output and evidence descriptions."),
        verificationNotes: stringArray("Describe one verification result.", "Verification results."),
        knownGaps: stringArray("Describe one known gap, or use an empty array.", "Known gaps."),
        residualRisks: stringArray("Describe one residual risk, or use an empty array.", "Residual risks."),
        commitSha: {
          type: "string",
          pattern: "^[0-9a-f]{40}$",
          example: "0000000000000000000000000000000000000000",
          description: "Full lowercase 40-character Git commit SHA.",
        },
      },
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "reason", "evidenceChecked"],
      properties: {
        verdict: {
          type: "string",
          enum: reviewVerdicts,
          example: "approved",
          description: "Execution Review verdict.",
        },
        reason: nonEmptyString("Explain why the delivery satisfies the task intent.", "Review rationale."),
        evidenceChecked: stringArray("Name one inspected evidence item.", "Inspected evidence identifiers."),
      },
    },
    consent: {
      type: "object",
      additionalProperties: false,
      required: ["approved"],
      properties: {
        approved: {
          type: "boolean",
          const: true,
          example: true,
          description: "Explicit owner approval for this exact packet.",
        },
      },
    },
    completion: {
      type: "object",
      additionalProperties: false,
      required: ["ci", "codeDocPaths"],
      properties: {
        ci: {
          type: "string",
          enum: closeoutCiJudgments,
          example: "passed",
          description: "Use passed only when the task contract declares the ci gate.",
        },
        codeDocPaths: portablePathArray(
          "path/to/code-or-doc",
          "Portable repository-relative paths to reconcile; use an empty array when none apply.",
        ),
      },
    },
  },
} as const satisfies SchemaNode & { readonly $schema: string; readonly $id: string; readonly title: string });

export type TaskCloseoutPacketValidation =
  | { readonly ok: true; readonly packet: TaskCloseoutPacket }
  | { readonly ok: false; readonly issues: readonly string[] };

export function validateTaskCloseoutPacket(value: unknown): TaskCloseoutPacketValidation {
  const issues: string[] = [];
  validateNode(taskCloseoutPacketSchema, value, "packet", issues);
  return issues.length ? { ok: false, issues } : { ok: true, packet: value as TaskCloseoutPacket };
}

export function createTaskCloseoutPacketTemplate(input: {
  readonly includeSubmission: boolean;
  readonly ci: CloseoutCiJudgment;
}): TaskCloseoutPacket {
  const template = exampleValue(taskCloseoutPacketSchema) as MutablePacket;
  if (!input.includeSubmission) delete template.submission;
  template.completion.ci = input.ci;
  return template;
}

export function taskCloseoutPacketHelp(): string {
  const lines: string[] = [`schema ${taskCloseoutPacketSchema.$id}`];
  collectHelp(taskCloseoutPacketSchema, "", true, false, lines);
  return lines.join("\n      ");
}

type MutablePacket = {
  submission?: SubmissionV1;
  review: TaskCloseoutPacket["review"];
  consent: TaskCloseoutPacket["consent"];
  completion: { ci: CloseoutCiJudgment; codeDocPaths: readonly string[] };
};

function validateNode(schema: SchemaNode, value: unknown, path: string, issues: string[]): void {
  if (schema.type === "object") {
    if (!record(value)) {
      issues.push(`${path} must be an object.`);
      return;
    }
    for (const field of schema.required) if (!Object.hasOwn(value, field)) issues.push(`${path}.${field} is required.`);
    for (const field of Object.keys(value))
      if (!Object.hasOwn(schema.properties, field)) issues.push(`${path}.${field} is not allowed.`);
    for (const [field, child] of Object.entries(schema.properties))
      if (Object.hasOwn(value, field)) validateNode(child, value[field], `${path}.${field}`, issues);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push(`${path} must be an array.`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issues.push(`${path} must contain at least ${schema.minItems} item(s).`);
    value.forEach((entry, index) => validateNode(schema.items, entry, `${path}[${index}]`, issues));
    return;
  }
  if (schema.type === "boolean") {
    if (value !== schema.const) issues.push(`${path} must be ${String(schema.const)}.`);
    return;
  }
  if (typeof value !== "string") {
    issues.push(`${path} must be a string.`);
    return;
  }
  if (schema.minLength !== undefined && value.trim().length < schema.minLength)
    issues.push(`${path} must be a non-empty string.`);
  if (schema.enum && !schema.enum.includes(value)) issues.push(`${path} must be one of: ${schema.enum.join(", ")}.`);
  if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
    issues.push(`${path} must match /${schema.pattern}/u.`);
  if (schema.format === "portable-relative-path") validatePortablePath(value, path, issues);
}

function validatePortablePath(value: string, path: string, issues: string[]): void {
  try {
    const normalized = normalizeRelativeDocumentPath(value);
    if (normalized !== value) issues.push(`${path} must already be a normalized portable relative path.`);
  } catch (error) {
    issues.push(`${path} must be a portable relative path: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function exampleValue(schema: SchemaNode): unknown {
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.type === "object")
    return Object.fromEntries(Object.entries(schema.properties).map(([field, child]) => [field, exampleValue(child)]));
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return schema.const;
  return schema.enum?.[0] ?? "";
}

function collectHelp(
  schema: SchemaNode,
  path: string,
  required: boolean,
  optionalAncestor: boolean,
  lines: string[],
): void {
  if (schema.type === "object") {
    if (path)
      lines.push(`${path}${required ? "" : "?"}: object${schema.description ? ` — ${schema.description}` : ""}`);
    for (const [field, child] of Object.entries(schema.properties))
      collectHelp(
        child,
        path ? `${path}.${field}` : field,
        schema.required.includes(field),
        optionalAncestor || !required,
        lines,
      );
    return;
  }
  const optional = !required || optionalAncestor ? " (optional section)" : "",
    kind =
      schema.type === "array"
        ? `${schema.items.type === "string" && schema.items.format === "portable-relative-path" ? "portable-path" : schema.items.type}[]`
        : schema.type === "string" && schema.enum
          ? schema.enum.join("|")
          : schema.type === "string" && schema.format === "portable-relative-path"
            ? "portable-path"
            : schema.type === "boolean"
              ? String(schema.const)
              : "string";
  lines.push(`${path}: ${kind}${optional}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
