// dec_42EB7B8F636C12381A447E52A3/CH2: pure Vertical/Preset/Gate/LivingDossier compiler owned by @harness-anything/preset.
// GUI-FDE delegates all compilation, gate checker generation, and result schema generation here.
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import {
  validateDossierSlots,
  type DossierSlot,
  type DossierTrigger,
  type LivingDossier,
} from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import { planVerticalScaffold } from "./vertical-scaffold.ts";
import type { FdeDomainDraft, FdeGateDraft, FdePresetDraft } from "./fde-studio-draft.ts";

export interface FdeMaterializedFile {
  readonly relativePath: string;
  readonly body: string;
  readonly sha256: string;
}

export interface FdeDossierValidation {
  readonly ok: boolean;
  readonly error?: string;
}

export interface CompiledFdeStudioPlan {
  readonly verticalId: string;
  readonly slug: string;
  readonly title: string;
  readonly relativeTargetDir: string;
  readonly defaultPresetId: string;
  readonly workPresetId: string;
  readonly files: readonly FdeMaterializedFile[];
  readonly livingDossier: LivingDossier;
  readonly dossierValidation: FdeDossierValidation;
}

interface ResolvedCommandGate {
  readonly gate: FdeGateDraft;
  readonly entrypointId: string;
  readonly entrypointRef: string;
  readonly scriptRelativePath: string;
}

function deterministicKindId(seed: string): string {
  return `KND-${sha256Text(seed).slice(0, 32)}`;
}

function jsonBody(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolvePrimaryPreset(draft: FdeDomainDraft): {
  readonly preset: FdePresetDraft | undefined;
  readonly defaultPresetId: string;
} {
  const preset = draft.presets.find((item) => item.presetId === draft.defaultPresetId) ?? draft.presets[0];
  return { preset, defaultPresetId: preset?.presetId ?? draft.defaultPresetId };
}

function resolveEntrypointScriptId(gate: FdeGateDraft, index: number): string {
  const trimmed = gate.entrypoint.trim();
  const slashIndex = trimmed.indexOf("/");
  const candidate = (slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed).trim();
  if (candidate.length > 0) return candidate;
  return index === 0 ? "verify-deliverable" : `verify-${gate.gateId}`;
}

function resolveCommandGates(draft: FdeDomainDraft, defaultPresetId: string): readonly ResolvedCommandGate[] {
  const result: ResolvedCommandGate[] = [];
  for (const [index, gate] of draft.gates.entries()) {
    if (gate.sourceKind !== "command") continue;
    const entrypointId = resolveEntrypointScriptId(gate, index);
    result.push({
      gate,
      entrypointId,
      entrypointRef: `${defaultPresetId}/${entrypointId}`,
      scriptRelativePath: `checks/${entrypointId}.mjs`,
    });
  }
  return result;
}

export function buildFdeLivingDossier(draft: FdeDomainDraft): LivingDossier {
  const slots: DossierSlot[] = draft.livingDossier.map((slot) => {
    const triggers: DossierTrigger[] = [
      { kind: "event-watermark", minimumDelta: Math.max(1, Math.trunc(slot.minimumDelta || 1)) },
      ...(slot.periodicMs !== null && slot.periodicMs > 0
        ? [{ kind: "periodic" as const, everyMs: Math.trunc(slot.periodicMs) }]
        : []),
    ];
    return {
      id: slot.id.trim(),
      path: slot.path.trim(),
      kind: slot.kind,
      title: slot.title.trim(),
      summary: slot.summary.trim(),
      entityKinds: slot.entityKinds.map((kind) => kind.trim()).filter(Boolean),
      requiredAnchors: slot.requiredAnchors.map((anchor) => anchor.trim()).filter(Boolean),
      watermarkMetadata: "required",
      triggers,
    };
  });
  return { slots };
}

export function validateFdeLivingDossier(draft: FdeDomainDraft, livingDossier: LivingDossier): FdeDossierValidation {
  if (livingDossier.slots.length === 0) return { ok: true };
  const entityKinds = new Set<string>(["task", "decision", "fact", ...draft.entities.map((entity) => entity.id)]);
  try {
    validateDossierSlots(draft.verticalId, livingDossier, entityKinds);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildFdeGateCheckerScript(gate: FdeGateDraft): string {
  const rules = gate.fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    constValue: field.constValue,
    minLength: field.minLength,
    pointer: field.pointer,
  }));
  return `import { readFileSync } from "node:fs";

const PREDICATE_TYPE = ${JSON.stringify(gate.predicateType)};
const ARTIFACT_PATH = ${JSON.stringify(gate.artifactPath)};
const FIELD_RULES = ${JSON.stringify(rules, null, 2)};

function emit(payload) {
  console.log(
    JSON.stringify({
      schema: "preset-script-result/v1",
      produces: [{ capabilityId: "completion-witness", payload }],
    }),
  );
}

function readPointer(target, pointer) {
  const segments = String(pointer || "").replace(/^\\//u, "").split("/").filter(Boolean);
  let cursor = target;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

const presetInput = JSON.parse(process.env.HA_PRESET_INPUT ?? "{}");
const witnessInput = JSON.parse(readFileSync(presetInput.witnessInput, "utf8"));
const subjects = (witnessInput.subjects ?? []).map(({ file: _file, ...identity }) => identity);
const target = (witnessInput.subjects ?? []).find(
  (entry) => typeof entry?.path === "string" && entry.path.endsWith("/" + ARTIFACT_PATH),
);

if (!target) {
  emit({
    result: "fail",
    subjects,
    predicateType: PREDICATE_TYPE,
    predicate: Object.fromEntries(FIELD_RULES.map((rule) => [rule.name, rule.type === "boolean" ? false : rule.type === "integer" || rule.type === "number" ? 0 : ""])),
    diagnostic: "Missing required artifact " + ARTIFACT_PATH + ".",
  });
  process.exit(0);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(target.file, "utf8"));
} catch (error) {
  emit({
    result: "fail",
    subjects,
    predicateType: PREDICATE_TYPE,
    predicate: Object.fromEntries(FIELD_RULES.map((rule) => [rule.name, rule.type === "boolean" ? false : rule.type === "integer" || rule.type === "number" ? 0 : ""])),
    diagnostic: "Artifact " + ARTIFACT_PATH + " is not valid JSON: " + String(error?.message ?? error),
  });
  process.exit(0);
}

const errors = [];
const predicate = {};
for (const rule of FIELD_RULES) {
  const actual = readPointer(parsed, rule.pointer);
  if (rule.type === "boolean") predicate[rule.name] = actual === true;
  else if (rule.type === "integer" || rule.type === "number") predicate[rule.name] = typeof actual === "number" ? actual : 0;
  else predicate[rule.name] = typeof actual === "string" ? actual : "";

  if (rule.constValue !== undefined && actual !== rule.constValue) {
    errors.push(rule.name + " must equal " + JSON.stringify(rule.constValue));
    continue;
  }
  if (rule.required && rule.type === "string" && (typeof actual !== "string" || actual.trim().length < (rule.minLength ?? 1))) {
    errors.push(rule.name + " must be a non-empty string");
  }
  if (rule.required && rule.type === "boolean" && typeof actual !== "boolean") {
    errors.push(rule.name + " must be a boolean");
  }
  if (rule.required && (rule.type === "integer" || rule.type === "number") && typeof actual !== "number") {
    errors.push(rule.name + " must be a number");
  }
}

emit({
  result: errors.length === 0 ? "pass" : "fail",
  subjects,
  predicateType: PREDICATE_TYPE,
  predicate,
  diagnostic: errors.length === 0 ? "Verified " + ARTIFACT_PATH + "." : errors.join("; "),
});
`;
}

export function buildFdeGateResultSchema(gate: FdeGateDraft): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const field of gate.fields) {
    if (field.required) required.push(field.name);
    const prop: Record<string, unknown> = { type: field.type };
    if (field.constValue !== undefined) prop.const = field.constValue;
    if (field.type === "string" && field.minLength !== undefined) prop.minLength = field.minLength;
    properties[field.name] = prop;
  }
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties,
  };
}

function patchVerticalJson(
  baseText: string,
  draft: FdeDomainDraft,
  livingDossier: LivingDossier,
  commandGates: readonly ResolvedCommandGate[],
): string {
  const parsed = JSON.parse(baseText) as Record<string, unknown>;
  const contractEntities = [
    { id: "task", entityType: "lifecycle", packageKind: "task-package/v2", contractEntity: true },
    { id: "decision", entityType: "lifecycle", packageKind: "decision-event/v1", contractEntity: true },
    { id: "fact", entityType: "schema", schemaRef: "schema://fact-event", contractEntity: true },
  ];
  const artifactEntities = draft.entities.map((entity) => {
    const attributes: Record<string, Record<string, unknown>> = {};
    for (const attr of entity.attributes) {
      attributes[attr.name] = {
        type: attr.type,
        ...(attr.enumValues.length > 0 ? { enum: [...attr.enumValues] } : {}),
        ...(attr.required ? { required: true } : {}),
      };
    }
    const entityRelations = draft.relations
      .filter((relation) => relation.sourceKind === entity.id)
      .map((relation) => ({
        type: relation.type,
        sourceKind: relation.sourceKind,
        targetKind: relation.targetKind,
        reads: relation.reads,
        strength: relation.strength,
        decisionClaimRef: relation.sourceDecisionRef,
        decisionContentPin: relation.sourceDecisionPin,
      }));
    return {
      kindId: deterministicKindId(`${draft.verticalId}:${entity.id}`),
      id: entity.id,
      entityType: "artifact",
      schemaVersions: [{ version: 1, attributes }],
      idPrefix: entity.idPrefix,
      display: { singular: entity.singular, plural: entity.plural },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: entity.pathTemplate },
      locatorKinds: [...entity.locatorKinds],
      ...(entityRelations.length > 0 ? { relations: entityRelations } : {}),
      ...(entity.maturityVocabulary.length > 0 ? { maturityVocabulary: [...entity.maturityVocabulary] } : {}),
    };
  });

  const commandGateByGateId = new Map<string, ResolvedCommandGate>(
    commandGates.map((resolved) => [resolved.gate.gateId, resolved]),
  );
  const sources: Record<string, unknown> = {
    "manual-attest": {
      kind: "manual",
      predicateType: "harness/attestation/v1",
      resultSchema: { type: "object", additionalProperties: false },
    },
  };
  const gates: Record<string, unknown> = {};
  for (const gate of draft.gates) {
    const resolvedCommand = commandGateByGateId.get(gate.gateId);
    sources[gate.sourceId] =
      gate.sourceKind === "command"
        ? {
            kind: "command",
            entrypoint: resolvedCommand?.entrypointRef ?? gate.entrypoint,
            predicateType: gate.predicateType,
            resultSchema: buildFdeGateResultSchema(gate),
          }
        : {
            kind: "manual",
            predicateType: gate.predicateType,
            resultSchema: buildFdeGateResultSchema(gate),
          };
    const bindings: Record<string, { readonly artifact: string; readonly pointer: string }> = {};
    for (const field of gate.fields) {
      if (field.pointer.trim()) bindings[field.name] = { artifact: gate.artifactPath, pointer: field.pointer.trim() };
    }
    gates[gate.gateId] = {
      source: gate.sourceId,
      appliesTo: "artifacts",
      subjects: [gate.artifactPath],
      bindings,
    };
  }

  return jsonBody({
    ...parsed,
    id: draft.verticalId,
    title: draft.title,
    version: draft.version,
    ...(livingDossier.slots.length > 0 ? { livingDossier } : {}),
    entityKinds: [...contractEntities, ...artifactEntities],
    completion: {
      sources,
      gates,
      closeoutDefaults: { review: false, consent: false, factDisposition: false },
    },
  });
}

function patchDefaultPresetJson(
  baseText: string,
  preset: FdePresetDraft | undefined,
  commandGates: readonly ResolvedCommandGate[],
): string {
  if (!preset) return baseText;
  const parsed = JSON.parse(baseText) as Record<string, unknown>;
  const existingProfiles = Array.isArray(parsed.profiles)
    ? (parsed.profiles as readonly { readonly templateSelections?: unknown }[])
    : [];
  const defaultTemplateSelections = existingProfiles[0]?.templateSelections ?? [];
  const profiles = preset.profiles.map((profile) => ({
    id: profile.id,
    title: profile.title,
    completionGates: [...profile.completionGates],
    templateSelections: defaultTemplateSelections,
  }));
  const defaultProfile =
    preset.profiles.length > 0 && !preset.profiles.some((profile) => profile.id === preset.defaultProfile)
      ? preset.profiles[0]!.id
      : preset.defaultProfile;
  const existingEntrypoints =
    parsed.entrypoints && typeof parsed.entrypoints === "object" ? (parsed.entrypoints as Record<string, unknown>) : {};
  const entrypoints: Record<string, unknown> = { ...existingEntrypoints };
  for (const resolved of commandGates) {
    entrypoints[resolved.entrypointId] = {
      type: "script",
      intent: `Verify ${resolved.gate.artifactPath} against ${resolved.gate.artifactSchema} and emit a completion-witness payload.`,
      inputs: [{ name: "witnessInput", type: "string", required: true }],
      requires: [],
      produces: [{ id: "completion-witness", kind: "checker", version: "1" }],
      sideEffects: [],
      command: resolved.scriptRelativePath,
    };
  }
  return jsonBody({
    ...parsed,
    id: preset.presetId,
    title: preset.title,
    kind: preset.presetKind,
    outputShape: preset.outputShape,
    entrypoints,
    profiles,
    defaultProfile,
  });
}

function parseSampleArtifact(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch (error) {
    return { _invalidSampleError: error instanceof Error ? error.message : String(error), raw: rawJson };
  }
}

/**
 * Pure compiler turning an FDE visual domain draft into a complete vertical package plan backed directly
 * by V4's canonical `planVerticalScaffold` and Kernel's `validateDossierSlots`.
 *
 * Single-source guarantee: command gate `completion.sources[].entrypoint`, `preset.json` `entrypoints`,
 * and `presets/<defaultPresetId>/checks/<script>.mjs` are all derived from the same resolved preset ID.
 */
export function compileFdeStudioDraft(draft: FdeDomainDraft, rootDir: string): CompiledFdeStudioPlan {
  const { preset: primaryPreset, defaultPresetId } = resolvePrimaryPreset(draft);
  const plan = planVerticalScaffold({
    rootDir,
    verticalId: draft.verticalId,
    slug: draft.slug,
    title: draft.title,
    defaultPresetId,
  });
  const livingDossier = buildFdeLivingDossier(draft);
  const dossierValidation = validateFdeLivingDossier(draft, livingDossier);
  const commandGates = resolveCommandGates(draft, plan.defaultPresetId);
  const fileMap = new Map<string, string>(
    plan.files
      .filter((entry) => !entry.relativePath.startsWith("agents/") && !entry.relativePath.startsWith("samples/"))
      .map((entry) => [entry.relativePath, entry.body]),
  );

  const verticalBase = fileMap.get("vertical.json");
  if (verticalBase) {
    fileMap.set("vertical.json", patchVerticalJson(verticalBase, draft, livingDossier, commandGates));
  }

  const defaultPresetPath = `presets/${plan.defaultPresetId}/preset.json`;
  const presetBase = fileMap.get(defaultPresetPath);
  if (presetBase) {
    fileMap.set(defaultPresetPath, patchDefaultPresetJson(presetBase, primaryPreset, commandGates));
  }

  const primaryTemplate = primaryPreset?.templates[0];
  if (primaryTemplate) {
    fileMap.set(`presets/${plan.defaultPresetId}/templates/brief/zh-CN.md`, primaryTemplate.zhCN);
    fileMap.set(`presets/${plan.defaultPresetId}/templates/brief/en-US.md`, primaryTemplate.enUS);
  }

  for (const resolved of commandGates) {
    fileMap.set(
      `presets/${plan.defaultPresetId}/${resolved.scriptRelativePath}`,
      buildFdeGateCheckerScript(resolved.gate),
    );
  }

  for (const agent of draft.agents) {
    fileMap.set(
      `agents/${agent.id}.json`,
      jsonBody({
        schema: "agent-declaration/v1",
        id: agent.id,
        name: agent.name,
        role: agent.role,
        instructions: agent.instructions,
        runtimes: [],
        skills: [...new Set(agent.skills.map((skill) => skill.trim()).filter(Boolean))].map((skill) => ({
          id: skill,
          path: `skills/${skill}`,
        })),
      }),
    );
  }
  for (const gate of draft.gates) {
    fileMap.set(
      `samples/${gate.gateId}/positive.json`,
      jsonBody({ artifacts: { [gate.artifactPath]: parseSampleArtifact(gate.positiveSampleJson) } }),
    );
    fileMap.set(
      `samples/${gate.gateId}/negative.json`,
      jsonBody({ artifacts: { [gate.artifactPath]: parseSampleArtifact(gate.negativeSampleJson) } }),
    );
  }

  const files: FdeMaterializedFile[] = [...fileMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, body]) => ({ relativePath, body, sha256: sha256Text(body) }));

  return {
    verticalId: plan.verticalId,
    slug: plan.slug,
    title: plan.title,
    relativeTargetDir: plan.relativeTargetDir,
    defaultPresetId: plan.defaultPresetId,
    workPresetId: plan.workPresetId,
    files,
    livingDossier,
    dossierValidation,
  };
}
