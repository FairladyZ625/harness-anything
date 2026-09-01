import type { SubmissionV1 } from "../domain/execution.ts";
import { reviewVerdicts, type ReviewVerdict } from "../domain/review.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";

const closeoutCiJudgments = ["passed", "not_applicable"] as const;
export type CloseoutCiJudgment = (typeof closeoutCiJudgments)[number];

export interface TaskCloseoutPacket {
  readonly submission?: SubmissionV1;
  readonly review: {
    readonly verdict: ReviewVerdict;
    readonly reason: string;
    readonly evidenceChecked: readonly string[];
    readonly externalCompletionAnchor?: string;
    readonly noDispatchReason?: string;
    readonly noIndependentReview?: true;
    readonly noIndependentReviewReason?: string;
  };
  readonly consent: { readonly approved: true };
  readonly completion: {
    readonly ci: CloseoutCiJudgment;
    readonly codeDocPaths: readonly string[];
  };
}

// `templateOmit` marks an optional field that is valid input but is left out of the generated
// `--print-template` scaffold, so the default template stays the standard shape while the field
// remains accepted when a caller supplies it.
type SchemaNode =
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, SchemaNode>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
      readonly description?: string;
      readonly example?: unknown;
      readonly templateOmit?: true;
    }
  | {
      readonly type: "array";
      readonly items: SchemaNode;
      readonly minItems?: number;
      readonly description?: string;
      readonly example?: unknown;
      readonly templateOmit?: true;
    }
  | {
      readonly type: "string";
      readonly minLength?: number;
      readonly pattern?: string;
      readonly format?: "portable-relative-path";
      readonly enum?: readonly string[];
      readonly description?: string;
      readonly example?: unknown;
      readonly templateOmit?: true;
    }
  | {
      readonly type: "boolean";
      readonly const: boolean;
      readonly description?: string;
      readonly example?: unknown;
      readonly templateOmit?: true;
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
      // The optional qualification fields let an owner-direct closeout justify a same-person review
      // when no dispatch record exists: an external completion anchor (a merged PR / commit SHA / CI
      // run), or an explicit no-independent-review weak mark. Which exact combination is admissible
      // stays governed downstream by the review packet, so the rule lives in one place; here they are
      // only allowed through the closeout packet shape.
      properties: {
        verdict: {
          type: "string",
          enum: reviewVerdicts,
          example: "approved",
          description: "Execution Review verdict.",
        },
        reason: nonEmptyString("Explain why the delivery satisfies the task intent.", "Review rationale."),
        evidenceChecked: stringArray("Name one inspected evidence item.", "Inspected evidence identifiers."),
        externalCompletionAnchor: {
          ...nonEmptyString(
            "e63a871c71520ae75a6854c20204aebccb726ef4",
            "Optional: a merged PR number, a 40-char origin/main commit SHA, or a CI run URL standing in for " +
              "dispatch attribution when none exists. Pair with noDispatchReason.",
          ),
          templateOmit: true,
        },
        noDispatchReason: {
          ...nonEmptyString(
            "Delivered through a retired external channel, so ha task dispatches is empty.",
            "Optional: why this task has no dispatch record. Required with externalCompletionAnchor.",
          ),
          templateOmit: true,
        },
        noIndependentReview: {
          type: "boolean",
          const: true,
          example: true,
          templateOmit: true,
          description:
            "Optional: explicitly declare there was no independent review. The recorded Review is marked " +
            "NO INDEPENDENT REVIEW and never passes as an independently-reviewed approval. " +
            "Pair with noIndependentReviewReason.",
        },
        noIndependentReviewReason: {
          ...nonEmptyString(
            "No independent reviewer was available for this documentation-only delivery.",
            "Optional: why no independent review is possible. Required with noIndependentReview.",
          ),
          templateOmit: true,
        },
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

type TaskCloseoutPacketValidation =
  | { readonly ok: true; readonly packet: TaskCloseoutPacket }
  | { readonly ok: false; readonly issues: readonly string[] };

export function validateTaskCloseoutPacket(value: unknown): TaskCloseoutPacketValidation {
  const issues: string[] = [];
  validatePacketNode(taskCloseoutPacketSchema, value, "packet", issues);
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

type MutablePacket = {
  submission?: SubmissionV1;
  review: TaskCloseoutPacket["review"];
  consent: TaskCloseoutPacket["consent"];
  completion: { ci: CloseoutCiJudgment; codeDocPaths: readonly string[] };
};

function validatePacketNode(schema: SchemaNode, value: unknown, path: string, issues: string[]): void {
  if (schema.type === "object") {
    if (!isPlainRecord(value)) {
      issues.push(`${path} must be an object.`);
      return;
    }
    for (const field of schema.required) if (!Object.hasOwn(value, field)) issues.push(`${path}.${field} is required.`);
    for (const field of Object.keys(value))
      if (!Object.hasOwn(schema.properties, field)) issues.push(`${path}.${field} is not allowed.`);
    for (const [field, child] of Object.entries(schema.properties))
      if (Object.hasOwn(value, field)) validatePacketNode(child, value[field], `${path}.${field}`, issues);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push(`${path} must be an array.`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issues.push(`${path} must contain at least ${schema.minItems} item(s).`);
    value.forEach((entry, index) => validatePacketNode(schema.items, entry, `${path}[${index}]`, issues));
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
    consumeKnownError(error);
    issues.push(`${path} must be a portable relative path: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function exampleValue(schema: SchemaNode): unknown {
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([, child]) => child.templateOmit !== true)
        .map(([field, child]) => [field, exampleValue(child)]),
    );
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return schema.const;
  return schema.enum?.[0] ?? "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
