import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, type CliError } from "../../cli/error-codes.ts";
import { isPathInside, normalizeSlashes } from "../../cli/path.ts";
import type { ResolvedPreset } from "./state.ts";

export const PRESET_POLICY_SCHEMA_CREATE_MILESTONE = "policy:artifact-contract/v1";
export const PRESET_POLICY_SCHEMA_MILESTONE_CLOSEOUT = "policy:closeout-boundary/v1";
export const PRESET_POLICY_SCHEMA_DECISION_CONFORMANCE = "policy:decision-conformance-rules/v1";
export const PRESET_TEMPLATE_PLAN_OVERRIDE = "policy:template-override/task-plan/v1";

const AdditionalReferenceSchema = Schema.Struct({
  kind: Schema.Literal("task", "decision", "document", "command"),
  ref: Schema.String,
  label: Schema.String
});

const CreateMilestoneArtifactSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("overview", "index", "machine-summary", "html", "supporting"),
  root: Schema.Literal("milestones", "task"),
  path: Schema.String
});

const CreateMilestonePolicySchema = Schema.Struct({
  schema: Schema.Literal("preset-policy/create-milestone/v1"),
  presetId: Schema.String,
  rules: Schema.Struct({
    requiredArtifacts: Schema.optional(Schema.Array(CreateMilestoneArtifactSchema)),
    charterAnchor: Schema.optional(Schema.Struct({
      required: Schema.Boolean,
      entityType: Schema.Literal("decision"),
      idPattern: Schema.String
    })),
    requiredSections: Schema.optional(Schema.Array(Schema.Literal("gate-retro", "fact-evidence"))),
    additionalReferences: Schema.optional(Schema.Array(AdditionalReferenceSchema))
  })
});

const MilestoneCloseoutPolicySchema = Schema.Struct({
  schema: Schema.Literal("preset-policy/milestone-closeout/v1"),
  presetId: Schema.String,
  rules: Schema.Struct({
    requireLoadBearingClaimCoverage: Schema.optional(Schema.Boolean),
    boundary: Schema.optional(Schema.Struct({
      kind: Schema.Literal("root-task-subtree"),
      rootTaskInput: Schema.Literal("milestoneRootTaskId")
    })),
    evidenceMode: Schema.optional(Schema.Literal("typed-canonical-projection"))
  })
});

const DecisionConformancePolicySchema = Schema.Struct({
  schema: Schema.Literal("preset-policy/decision-conformance/v1"),
  presetId: Schema.String,
  rules: Schema.Struct({
    adoptionCutoff: Schema.optional(Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u))),
    legacyExemptions: Schema.optional(Schema.Array(Schema.Struct({
      kind: Schema.Literal("decided-before-cutoff", "missing-decided-at-with-legacy-id")
    }))),
    proposedMaxAgeDays: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))),
    enforcement: Schema.optional(Schema.Literal("report", "fail"))
  })
});

const _PresetPolicyDocumentSchema = Schema.Union(
  CreateMilestonePolicySchema,
  MilestoneCloseoutPolicySchema,
  DecisionConformancePolicySchema
);

type PresetPolicyDocument = Schema.Schema.Type<typeof _PresetPolicyDocumentSchema>;
type DeclaredPolicySchema = PresetPolicyDocument["schema"];

type PolicyEnvelopeDefinition = Readonly<{
  readonly capabilityId: string;
  readonly schema: DeclaredPolicySchema;
  readonly parser: (input: unknown) => PresetPolicyDocument;
  readonly ruleKeys: ReadonlyArray<string>;
  readonly validateEnvelopeRules: (rules: Record<string, unknown>) => void;
  readonly validatePolicy: (manifestId: string, policy: PresetPolicyDocument) => void;
}>;

const POLICY_ENVELOPES: ReadonlyArray<PolicyEnvelopeDefinition> = [
  {
    capabilityId: PRESET_POLICY_SCHEMA_CREATE_MILESTONE,
    schema: "preset-policy/create-milestone/v1",
    parser: (input) => Schema.decodeUnknownSync(CreateMilestonePolicySchema)(input),
    ruleKeys: ["requiredArtifacts", "charterAnchor", "requiredSections", "additionalReferences"],
    validateEnvelopeRules: (rules) => {
      exactObjectArray(rules.requiredArtifacts, "$.rules.requiredArtifacts", ["id", "role", "root", "path"]);
      if (rules.charterAnchor !== undefined) {
        exactObject(rules.charterAnchor, "$.rules.charterAnchor", ["required", "entityType", "idPattern"]);
      }
      exactObjectArray(rules.additionalReferences, "$.rules.additionalReferences", ["kind", "ref", "label"]);
    },
    validatePolicy: (manifestId, policy) => {
      const envelopePolicy = policy as Extract<PresetPolicyDocument, { readonly schema: "preset-policy/create-milestone/v1" }>;
      if (policy.presetId !== manifestId) {
        throw new Error(`Preset policy presetId ${policy.presetId} does not match manifest ${manifestId}.`);
      }
      if (envelopePolicy.rules.charterAnchor) {
        new RegExp(envelopePolicy.rules.charterAnchor.idPattern, "u");
      }
      if (envelopePolicy.rules.requiredArtifacts) {
        validateCreateMilestoneArtifacts(envelopePolicy.rules.requiredArtifacts);
      }
    }
  },
  {
    capabilityId: PRESET_POLICY_SCHEMA_MILESTONE_CLOSEOUT,
    schema: "preset-policy/milestone-closeout/v1",
    parser: (input) => Schema.decodeUnknownSync(MilestoneCloseoutPolicySchema)(input),
    ruleKeys: ["requireLoadBearingClaimCoverage", "boundary", "evidenceMode"],
    validateEnvelopeRules: (rules) => {
      if (rules.boundary !== undefined) {
        exactObject(rules.boundary, "$.rules.boundary", ["kind", "rootTaskInput"]);
      }
    },
    validatePolicy: (manifestId, policy) => {
      if (policy.presetId !== manifestId) {
        throw new Error(`Preset policy presetId ${policy.presetId} does not match manifest ${manifestId}.`);
      }
    }
  },
  {
    capabilityId: PRESET_POLICY_SCHEMA_DECISION_CONFORMANCE,
    schema: "preset-policy/decision-conformance/v1",
    parser: (input) => Schema.decodeUnknownSync(DecisionConformancePolicySchema)(input),
    ruleKeys: ["adoptionCutoff", "legacyExemptions", "proposedMaxAgeDays", "enforcement"],
    validateEnvelopeRules: (rules) => {
      exactObjectArray(rules.legacyExemptions, "$.rules.legacyExemptions", ["kind"]);
    },
    validatePolicy: (manifestId, policy) => {
      const envelopePolicy = policy as Extract<PresetPolicyDocument, { readonly schema: "preset-policy/decision-conformance/v1" }>;
      if (policy.presetId !== manifestId) {
        throw new Error(`Preset policy presetId ${policy.presetId} does not match manifest ${manifestId}.`);
      }
      if (!envelopePolicy.rules.adoptionCutoff) return;
      const cutoff = Date.parse(envelopePolicy.rules.adoptionCutoff);
      if (!Number.isFinite(cutoff)) {
        throw new Error("Decision conformance adoptionCutoff must be a valid ISO timestamp.");
      }
    }
  }
];

const POLICY_ENVELOPE_BY_CAPABILITY_ID = new Map<string, PolicyEnvelopeDefinition>(
  POLICY_ENVELOPES.map((envelope) => [envelope.capabilityId, envelope])
);

const POLICY_ENVELOPE_BY_SCHEMA = new Map<DeclaredPolicySchema, PolicyEnvelopeDefinition>(
  POLICY_ENVELOPES.map((envelope) => [envelope.schema, envelope])
);

const POLICY_ENVELOPE_SCHEMA_BY_CAPABILITY = new Set(POLICY_ENVELOPES.map((envelope) => envelope.capabilityId));

export interface ResolvedPresetPolicy {
  readonly schema: PresetPolicyDocument["schema"];
  readonly presetId: PresetPolicyDocument["presetId"];
  readonly sourcePath: string;
  readonly rules: PresetPolicyDocument["rules"];
}

export type PresetPolicyResolution =
  | { readonly ok: true; readonly policy: ResolvedPresetPolicy | null }
  | { readonly ok: false; readonly error: CliError };

export interface ScriptPolicySubject {
  readonly source: "user" | "vertical" | "preset";
  readonly scriptId: string;
  readonly presetId?: string;
}

export function resolveScriptPolicy(
  rootInput: HarnessLayoutInput,
  presets: ReadonlyArray<ResolvedPreset>,
  subject: ScriptPolicySubject
): PresetPolicyResolution {
  if (subject.source === "preset") {
    const owner = presets.find((preset) => preset.manifest.id === subject.presetId);
    return owner ? resolvePresetPolicy(rootInput, owner) : { ok: true, policy: null };
  }
  if (subject.source !== "vertical") return { ok: true, policy: null };

  const owners = presets.filter((preset) =>
    preset.manifest.policyPath &&
    preset.manifest.capabilityImports.some((capability) => capability.id === subject.scriptId)
  );
  if (owners.length === 0) return { ok: true, policy: null };
  if (owners.length > 1) {
    return invalidPolicy(
      `Script ${subject.scriptId} has multiple policy-owning presets: ${owners.map((owner) => owner.manifest.id).join(", ")}.`
    );
  }
  return resolvePresetPolicy(rootInput, owners[0]);
}

export function resolvePresetPolicy(rootInput: HarnessLayoutInput, preset: ResolvedPreset): PresetPolicyResolution {
  const declaredPath = preset.manifest.policyPath;
  if (!declaredPath) return { ok: true, policy: null };

  const expectedPath = `{{paths.authoredRoot}}/policies/presets/${preset.manifest.id}.policy.json`;
  if (declaredPath !== expectedPath) {
    return invalidPolicy(`Preset ${preset.manifest.id} policyPath must be ${expectedPath}.`);
  }

  const layout = resolveHarnessLayout(rootInput);
  // A policy governs the authored ledger, so it is versioned with authoredRoot.
  // Public checkouts without that ledger correctly receive the null/public-default behavior.
  const policyRoot = path.join(layout.authoredRoot, "policies", "presets");
  const policyPath = path.join(policyRoot, `${preset.manifest.id}.policy.json`);
  if (!existsSync(policyPath)) return { ok: true, policy: null };
  if (!isPathInside(policyRoot, policyPath)) {
    return invalidPolicy(`Preset ${preset.manifest.id} policyPath resolves outside the authored policy directory.`);
  }
  const declaredSchemas = declaredPolicySchemas(preset.manifest);
  if (declaredSchemas.size === 0) {
    return invalidPolicy(`Preset ${preset.manifest.id} does not declare a registered policy envelope capability.`);
  }

  try {
    const raw = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
    const envelope = validatePolicyEnvelopeHeader(raw);
    const policySchema = envelope.schema as DeclaredPolicySchema;
    if (!declaredSchemas.has(policySchema)) {
      return invalidPolicy(`Preset ${preset.manifest.id} has not declared policy support for ${policySchema}.`);
    }
    const definition = POLICY_ENVELOPE_BY_SCHEMA.get(policySchema);
    if (!definition) {
      return invalidPolicy(`Preset policy schema ${policySchema} is not recognized.`);
    }
    const rules = exactObject(envelope.rules, "$.rules", definition.ruleKeys);
    definition.validateEnvelopeRules(rules);
    const policy = definition.parser(raw);
    definition.validatePolicy(preset.manifest.id, policy);
    return {
      ok: true,
      policy: {
        ...policy,
        sourcePath: normalizeSlashes(path.relative(layout.rootDir, policyPath))
      }
    };
  } catch (error) {
    return invalidPolicy(error instanceof Error ? error.message : `Preset ${preset.manifest.id} policy failed validation.`);
  }
}

function validatePolicyEnvelopeHeader(input: unknown): { readonly [key: string]: unknown } {
  const envelope = exactObject(input, "$", ["schema", "presetId", "rules"]);
  if (typeof envelope.schema !== "string") {
    throw new Error(`$.schema must be a string.`);
  }
  if (typeof envelope.presetId !== "string") {
    throw new Error(`$.presetId must be a string.`);
  }
  if (typeof envelope.rules !== "object" || envelope.rules === null || Array.isArray(envelope.rules)) {
    throw new Error(`$.rules must be an object.`);
  }
  return envelope;
}

function declaredPolicySchemas(manifest: { readonly capabilityImports: ReadonlyArray<{ readonly id: string }> }): Set<string> {
  const declarations = new Set<string>();
  for (const capability of manifest.capabilityImports) {
    if (!POLICY_ENVELOPE_SCHEMA_BY_CAPABILITY.has(capability.id)) continue;
    const schema = POLICY_ENVELOPE_BY_CAPABILITY_ID.get(capability.id)?.schema;
    if (schema !== undefined) {
      declarations.add(schema);
    }
  }
  return declarations;
}

export function presetSupportsTemplatePlanOverride(manifest: { readonly capabilityImports: ReadonlyArray<{ readonly id: string }> }): boolean {
  return manifest.capabilityImports.some((capability) => capability.id === PRESET_TEMPLATE_PLAN_OVERRIDE);
}

function validateCreateMilestoneArtifacts(artifacts: ReadonlyArray<{
  readonly id: string;
  readonly role: "overview" | "index" | "machine-summary" | "html" | "supporting";
  readonly root: "milestones" | "task";
  readonly path: string;
}>): void {
  const ids = new Set<string>();
  const singletonRoles = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.id.trim()) throw new Error("$.rules.requiredArtifacts[].id must not be empty.");
    if (ids.has(artifact.id)) throw new Error(`Duplicate create-milestone artifact id: ${artifact.id}.`);
    ids.add(artifact.id);
    if (artifact.role !== "supporting") {
      if (singletonRoles.has(artifact.role)) throw new Error(`Duplicate create-milestone artifact role: ${artifact.role}.`);
      singletonRoles.add(artifact.role);
    }
    validateArtifactPath(artifact.path);
  }
  for (const role of ["overview", "index", "machine-summary"]) {
    if (!singletonRoles.has(role)) throw new Error(`Create-milestone policy requiredArtifacts must include role ${role}.`);
  }
}

function validateArtifactPath(value: string): void {
  const normalized = normalizeSlashes(value.trim());
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Create-milestone artifact path must be a safe relative path: ${value}.`);
  }
  const placeholders = [...normalized.matchAll(/\{\{([^}]+)\}\}/gu)].map((match) => match[1]);
  if (placeholders.some((placeholder) => placeholder !== "line" && placeholder !== "slug")) {
    throw new Error(`Create-milestone artifact path contains an unsupported placeholder: ${value}.`);
  }
}

function exactObject(input: unknown, at: string, allowedKeys: ReadonlyArray<string>): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${at} must be an object.`);
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${at}.${key} is not allowed.`);
  }
  return value;
}

function exactObjectArray(input: unknown, at: string, allowedKeys: ReadonlyArray<string>): void {
  if (input === undefined) return;
  if (!Array.isArray(input)) throw new Error(`${at} must be an array.`);
  for (const [index, value] of input.entries()) exactObject(value, `${at}[${index}]`, allowedKeys);
}

function invalidPolicy(hint: string): PresetPolicyResolution {
  return { ok: false, error: cliError(CliErrorCode.PresetPolicyInvalid, hint) };
}
