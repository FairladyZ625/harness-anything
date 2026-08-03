import {
  taskCompleteExternalCheckpointKinds,
  taskSubmissionOutputEvidenceId,
  type TaskCompleteExternalCheckpointRef
} from "@harness-anything/application";
import {
  consentActions as supportedConsentActions,
  type ConsentAction
} from "@harness-anything/kernel";

export type TaskPacketCommandKind = "task-submit" | "task-complete";
type TaskPacketJsonType = "string" | "boolean" | "array" | "object";

export interface TaskPacketValueSchema {
  readonly type: TaskPacketJsonType;
  readonly description?: string;
  readonly nonEmpty?: boolean;
  readonly values?: ReadonlyArray<string>;
  readonly requiredProperties?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, TaskPacketValueSchema>>;
  readonly exactProperties?: boolean;
  readonly items?: TaskPacketValueSchema;
}

export interface TaskPacketFieldSchema extends TaskPacketValueSchema {
  readonly description: string;
  readonly required?: boolean;
  readonly template?: unknown;
}

export interface TaskPacketContract {
  readonly commandKind: TaskPacketCommandKind;
  readonly schemaId: string;
  readonly fileName: "submission.json" | "approval.json";
  readonly fields: Readonly<Record<string, TaskPacketFieldSchema>>;
  readonly validate?: (payload: Readonly<Record<string, unknown>>) => string | undefined;
}

export interface TaskPacketTemplate {
  readonly fileName: TaskPacketContract["fileName"];
  readonly value: Readonly<Record<string, unknown>>;
}

export interface TaskSubmitPacket {
  readonly completionClaim: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
  readonly verificationNotes: ReadonlyArray<string>;
  readonly knownGaps: ReadonlyArray<string>;
  readonly residualRisks: ReadonlyArray<string>;
  readonly executionId?: string;
  readonly leaseToken?: string;
}

export interface TaskCompleteApprovalPacket {
  readonly findings: string;
  readonly rationale: string;
  readonly evidenceChecked?: ReadonlyArray<string>;
  readonly archiveWarningsAcknowledged?: boolean;
  readonly consentId?: string;
  readonly consentUtterance?: string;
  readonly consentStandingPolicyDecisionId?: string;
  readonly consentAssertedRationale?: string;
  readonly consentActions?: ReadonlyArray<ConsentAction>;
  readonly ci?: "passed" | "failed" | "not-applicable";
  readonly executionId?: string;
  readonly commit?: string;
  readonly paths?: ReadonlyArray<string>;
  readonly prRef?: string;
  readonly externalCheckpointRefs?: ReadonlyArray<TaskCompleteExternalCheckpointRef>;
  readonly reviewerId?: string;
}

export type TaskPacketDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

const nonEmptyString: TaskPacketValueSchema = { type: "string", nonEmpty: true };
const nonEmptyStringArray: TaskPacketValueSchema = {
  type: "array",
  items: nonEmptyString
};
const firstOutputEvidenceId = taskSubmissionOutputEvidenceId(0);
const consentSourceFields = [
  "consentId",
  "consentUtterance",
  "consentStandingPolicyDecisionId",
  "consentAssertedRationale"
] as const;

const taskSubmitPacketContract: TaskPacketContract = {
  commandKind: "task-submit",
  schemaId: "harness://schema/cli/task-submit-input/v1",
  fileName: "submission.json",
  fields: {
    completionClaim: {
      type: "string",
      nonEmpty: true,
      required: true,
      template: "<what is complete>",
      description: "Non-empty claim describing what is complete."
    },
    deliverables: {
      ...nonEmptyStringArray,
      required: true,
      template: ["<delivered file, behavior, or result>"],
      description: "Delivered results; every item must be a non-empty string."
    },
    outputs: {
      ...nonEmptyStringArray,
      required: true,
      template: ["<output evidence>"],
      description: `Inline evidence text. Output 1 becomes ${firstOutputEvidenceId}, output 2 becomes ${taskSubmissionOutputEvidenceId(1)}, and so on.`
    },
    verificationNotes: {
      ...nonEmptyStringArray,
      required: true,
      template: ["<verification command and result>"],
      description: "Verification commands and observed results."
    },
    knownGaps: {
      ...nonEmptyStringArray,
      required: true,
      template: [],
      description: "Known incomplete areas; use an empty array when none are known."
    },
    residualRisks: {
      ...nonEmptyStringArray,
      required: true,
      template: [],
      description: "Residual risks; use an empty array when none remain."
    },
    executionId: {
      type: "string",
      nonEmpty: true,
      description: "Optional active Execution id; inferred from the active Holder V2 round when omitted."
    },
    leaseToken: {
      type: "string",
      nonEmpty: true,
      description: "Optional Holder V2 lease token; the active local actor normally omits it."
    }
  }
};

const checkpointRefSchema: TaskPacketValueSchema = {
  type: "object",
  requiredProperties: ["kind", "ref"],
  exactProperties: true,
  properties: {
    kind: {
      type: "string",
      values: taskCompleteExternalCheckpointKinds
    },
    ref: nonEmptyString
  }
};

const taskCompletePacketContract: TaskPacketContract = {
  commandKind: "task-complete",
  schemaId: "harness://schema/cli/task-complete-input/v1",
  fileName: "approval.json",
  fields: {
    findings: {
      type: "string",
      nonEmpty: true,
      required: true,
      template: "<review findings>",
      description: "Non-empty owner approval findings."
    },
    rationale: {
      type: "string",
      nonEmpty: true,
      required: true,
      template: "<why the evidence supports approval>",
      description: "Non-empty rationale connecting the inspected evidence to approval."
    },
    evidenceChecked: {
      ...nonEmptyStringArray,
      template: [firstOutputEvidenceId],
      description: `Each item must be an execution.outputs[].evidence_id. With the submit template's first output, use ${firstOutputEvidenceId}; do not put free-form evidence text here.`
    },
    archiveWarningsAcknowledged: {
      type: "boolean",
      template: true,
      description: "Must be true when any bound Session archive is partial or unavailable; true is also accepted when no warning exists."
    },
    consentId: {
      type: "string",
      nonEmpty: true,
      description: "Reuse an existing open consent id; omit consentActions with this source."
    },
    consentUtterance: {
      type: "string",
      nonEmpty: true,
      description: "Human's exact approval words from the bound transcript."
    },
    consentStandingPolicyDecisionId: {
      type: "string",
      nonEmpty: true,
      description: "Active standing-policy decision id authorizing approval."
    },
    consentAssertedRationale: {
      type: "string",
      nonEmpty: true,
      template: "<how owner approval was obtained outside the bound transcript>",
      description: "Explicit rationale for externally obtained approval."
    },
    consentActions: {
      type: "array",
      items: {
        type: "string",
        values: supportedConsentActions
      },
      template: [...supportedConsentActions],
      description: "For a newly declared consent source, the template supplies the default scope; if provided, include approve_execution and complete_task exactly once. Omit when using consentId."
    },
    ci: {
      type: "string",
      values: ["passed", "failed", "not-applicable"],
      template: "passed",
      description: "CI result. Contracts with a CI completion gate require passed."
    },
    executionId: {
      type: "string",
      nonEmpty: true,
      description: "Submitted Execution id; inferred only when one submitted round is eligible."
    },
    commit: {
      type: "string",
      nonEmpty: true,
      template: "<full 40-character public workspace commit SHA>",
      description: "Public workspace Git ref. The template uses the full SHA required by code-doc reconcile; use the identical value in both places."
    },
    paths: {
      ...nonEmptyStringArray,
      template: ["<repo-relative delivered path>"],
      description: "Repository-relative anchors. Repeat --path with these exact values during code-doc reconcile."
    },
    prRef: {
      type: "string",
      nonEmpty: true,
      description: "Optional PR reference. If present, pass the identical value as --pr during code-doc reconcile."
    },
    externalCheckpointRefs: {
      type: "array",
      items: checkpointRefSchema,
      template: [],
      description: `Optional prepublish witnesses shaped as { kind: ${taskCompleteExternalCheckpointKinds.join("|")}, ref: <non-empty encoded ref> }; leave [] for daemon production.`
    },
    reviewerId: {
      type: "string",
      nonEmpty: true,
      description: "Optional compatibility label; the authenticated actor, not this string, is recorded as reviewer_actor."
    }
  },
  validate: validateTaskCompleteConsent
};

const taskPacketContracts: Readonly<Record<TaskPacketCommandKind, TaskPacketContract>> = {
  "task-submit": taskSubmitPacketContract,
  "task-complete": taskCompletePacketContract
};

export function taskPacketContractFor(commandKind: string): TaskPacketContract | undefined {
  return taskPacketContracts[commandKind as TaskPacketCommandKind];
}

export function taskPacketTemplateFor(commandKind: string): TaskPacketTemplate | undefined {
  const contract = taskPacketContractFor(commandKind);
  if (!contract) return undefined;
  const value = Object.fromEntries(Object.entries(contract.fields)
    .filter(([, field]) => Object.hasOwn(field, "template"))
    .map(([name, field]) => [name, field.template]));
  return {
    fileName: contract.fileName,
    value
  };
}

export function taskPacketInputDefinitionFor(commandKind: string): {
  readonly required: ReadonlyArray<string>;
  readonly properties: Readonly<Record<string, {
    readonly type: TaskPacketJsonType;
    readonly description: string;
    readonly items?: { readonly type: TaskPacketJsonType; readonly properties?: Record<string, unknown> };
  }>>;
} | undefined {
  const contract = taskPacketContractFor(commandKind);
  if (!contract) return undefined;
  return {
    required: Object.entries(contract.fields).flatMap(([name, field]) => field.required ? [name] : []),
    properties: Object.fromEntries(Object.entries(contract.fields).map(([name, field]) => [name, {
      type: field.type,
      description: field.description,
      ...(field.items ? { items: {
        type: field.items.type,
        ...(field.items.properties ? { properties: field.items.properties } : {})
      } } : {})
    }]))
  };
}

export function taskPacketCrossFieldRuleDescriptions(commandKind: string): ReadonlyArray<string> {
  if (commandKind !== "task-complete") return [];
  return [
    `Provide exactly one consent source: ${consentSourceFields.join(", ")}.`,
    `When consentActions is provided for new consent, it must contain ${supportedConsentActions.join(" and ")} exactly once; omit consentActions when using consentId.`
  ];
}

export function decodeTaskSubmitPacket(value: unknown): TaskPacketDecodeResult<TaskSubmitPacket> {
  const decoded = decodeTaskPacket(taskSubmitPacketContract, value);
  return decoded.ok
    ? { ok: true, value: decoded.value as unknown as TaskSubmitPacket }
    : decoded;
}

export function decodeTaskCompleteApprovalPacket(
  value: unknown
): TaskPacketDecodeResult<TaskCompleteApprovalPacket> {
  const decoded = decodeTaskPacket(taskCompletePacketContract, value);
  return decoded.ok
    ? { ok: true, value: decoded.value as unknown as TaskCompleteApprovalPacket }
    : decoded;
}

function decodeTaskPacket(
  contract: TaskPacketContract,
  value: unknown
): TaskPacketDecodeResult<Readonly<Record<string, unknown>>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issue: `${contract.fileName} must contain one JSON object.` };
  }
  const payload = value as Readonly<Record<string, unknown>>;
  for (const [name, field] of Object.entries(contract.fields)) {
    if (!Object.hasOwn(payload, name)) {
      if (field.required) return { ok: false, issue: `${contract.fileName} field ${name} is required.` };
      continue;
    }
    const issue = validatePacketValue(payload[name], field, name);
    if (issue) return { ok: false, issue: `${contract.fileName} field ${issue}` };
  }
  const issue = contract.validate?.(payload);
  return issue ? { ok: false, issue } : { ok: true, value: payload };
}

function validatePacketValue(value: unknown, schema: TaskPacketValueSchema, path: string): string | undefined {
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (schema.nonEmpty && value.trim().length === 0) return `${path} must be a non-empty string.`;
    if (schema.values && !schema.values.includes(value)) {
      return `${path} must be one of: ${schema.values.join(", ")}.`;
    }
    return undefined;
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? undefined : `${path} must be a boolean.`;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (!schema.items) return undefined;
    for (const [index, entry] of value.entries()) {
      const issue = validatePacketValue(entry, schema.items, `${path}[${index}]`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
  const record = value as Readonly<Record<string, unknown>>;
  const properties = schema.properties ?? {};
  for (const required of schema.requiredProperties ?? []) {
    if (!Object.hasOwn(record, required)) return `${path}.${required} is required.`;
  }
  if (schema.exactProperties) {
    const unknown = Object.keys(record).find((key) => !Object.hasOwn(properties, key));
    if (unknown) return `${path}.${unknown} is not supported.`;
  }
  for (const [name, child] of Object.entries(properties)) {
    if (!Object.hasOwn(record, name)) continue;
    const issue = validatePacketValue(record[name], child, `${path}.${name}`);
    if (issue) return issue;
  }
  return undefined;
}

function validateTaskCompleteConsent(payload: Readonly<Record<string, unknown>>): string | undefined {
  const sources = consentSourceFields.filter((key) => typeof payload[key] === "string"
    && String(payload[key]).trim().length > 0);
  if (sources.length !== 1) {
    return `approval.json requires exactly one consent source: ${consentSourceFields.join(", ")}.`;
  }
  const actions = payload.consentActions as ReadonlyArray<string> | undefined;
  if (sources[0] === "consentId" && actions !== undefined) {
    return "approval.json field consentActions must be omitted when using consentId.";
  }
  if (actions !== undefined && (actions.length !== supportedConsentActions.length
    || new Set(actions).size !== actions.length
    || supportedConsentActions.some((action) => !actions.includes(action)))) {
    return `approval.json field consentActions must contain ${supportedConsentActions.join(" and ")} exactly once.`;
  }
  return undefined;
}
