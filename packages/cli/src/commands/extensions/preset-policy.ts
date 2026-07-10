import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, type CliError } from "../../cli/error-codes.ts";
import { isPathInside, normalizeSlashes } from "../../cli/path.ts";
import type { ResolvedPreset } from "./state.ts";

const AdditionalReferenceSchema = Schema.Struct({
  kind: Schema.Literal("task", "decision", "document", "command"),
  ref: Schema.String,
  label: Schema.String
});

const CreateMilestonePolicySchema = Schema.Struct({
  schema: Schema.Literal("preset-policy/create-milestone/v1"),
  presetId: Schema.Literal("create-milestone"),
  rules: Schema.Struct({
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
  presetId: Schema.Literal("milestone-closeout"),
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
  presetId: Schema.Literal("decision-conformance"),
  rules: Schema.Struct({
    adoptionCutoff: Schema.optional(Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u))),
    legacyExemptions: Schema.optional(Schema.Array(Schema.Struct({
      kind: Schema.Literal("decided-before-cutoff", "missing-decided-at-with-legacy-id")
    }))),
    proposedMaxAgeDays: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))),
    enforcement: Schema.optional(Schema.Literal("report", "fail"))
  })
});

const PresetPolicyDocumentSchema = Schema.Union(
  CreateMilestonePolicySchema,
  MilestoneCloseoutPolicySchema,
  DecisionConformancePolicySchema
);

type PresetPolicyDocument = Schema.Schema.Type<typeof PresetPolicyDocumentSchema>;

export interface ResolvedPresetPolicy {
  readonly schema: PresetPolicyDocument["schema"];
  readonly presetId: PresetPolicyDocument["presetId"];
  readonly sourcePath: string;
  readonly rules: PresetPolicyDocument["rules"];
}

export type PresetPolicyResolution =
  | { readonly ok: true; readonly policy: ResolvedPresetPolicy | null }
  | { readonly ok: false; readonly error: CliError };

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

  try {
    const raw = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
    validateExactPolicyShape(raw, preset.manifest.id);
    const policy = Schema.decodeUnknownSync(PresetPolicyDocumentSchema)(raw);
    if (policy.presetId !== preset.manifest.id) {
      return invalidPolicy(`Preset policy ${policy.presetId} does not match manifest ${preset.manifest.id}.`);
    }
    if (policy.presetId === "create-milestone" && policy.rules.charterAnchor) {
      new RegExp(policy.rules.charterAnchor.idPattern, "u");
    }
    if (policy.presetId === "decision-conformance" && policy.rules.adoptionCutoff) {
      const cutoff = Date.parse(policy.rules.adoptionCutoff);
      if (!Number.isFinite(cutoff)) throw new Error("Decision conformance adoptionCutoff must be a valid ISO timestamp.");
    }
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

function validateExactPolicyShape(input: unknown, presetId: string): void {
  const envelope = exactObject(input, "$", ["schema", "presetId", "rules"]);
  if (envelope.presetId !== presetId) {
    throw new Error(`Preset policy presetId must be ${presetId}.`);
  }
  const rules = exactObject(envelope.rules, "$.rules", policyRuleKeys(presetId));

  if (presetId === "create-milestone") {
    if (rules.charterAnchor !== undefined) {
      exactObject(rules.charterAnchor, "$.rules.charterAnchor", ["required", "entityType", "idPattern"]);
    }
    exactObjectArray(rules.additionalReferences, "$.rules.additionalReferences", ["kind", "ref", "label"]);
    return;
  }
  if (presetId === "milestone-closeout") {
    if (rules.boundary !== undefined) {
      exactObject(rules.boundary, "$.rules.boundary", ["kind", "rootTaskInput"]);
    }
    return;
  }
  if (presetId === "decision-conformance") {
    exactObjectArray(rules.legacyExemptions, "$.rules.legacyExemptions", ["kind"]);
    return;
  }
  throw new Error(`Preset ${presetId} does not declare a registered policy decoder.`);
}

function policyRuleKeys(presetId: string): ReadonlyArray<string> {
  if (presetId === "create-milestone") return ["charterAnchor", "requiredSections", "additionalReferences"];
  if (presetId === "milestone-closeout") return ["requireLoadBearingClaimCoverage", "boundary", "evidenceMode"];
  if (presetId === "decision-conformance") return ["adoptionCutoff", "legacyExemptions", "proposedMaxAgeDays", "enforcement"];
  return [];
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
