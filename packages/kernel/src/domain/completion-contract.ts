import { hasOnlyFields, hasRequiredFields, isRecord, isNonEmptyString } from "./contract-validation.ts";
import type { ContractValidationIssue } from "./task.ts";
import type {
  CompletionGateDeclaration,
  VerticalCompletionDeclaration,
  WitnessSourceDefinition,
} from "./completion-source.ts";

import {
  effectiveCloseoutGates,
  isValidCloseoutGateRecord,
  type CloseoutGate,
  type CloseoutOverridesV1,
  type CloseoutSettingsV1,
} from "./settings-closeout.ts";
import { gateAppliesTo, type GateAppliesTo } from "./completion-source.ts";
export { gateAppliesTo, type GateAppliesTo } from "./completion-source.ts";
export const CODE_DOC_GATE_ID = "code-doc-reconciliation";
export interface GithubWitnessOptions {
  readonly workflows: readonly string[];
  readonly branch: string;
  readonly event: string;
  readonly coverage: "exact" | "descendant";
  readonly selection: "newest";
}
export type FrozenGateWitness =
  | {
      /** Offline acceptance history only. This is not an executable source definition. */
      readonly kind: "historical";
      readonly adapterId: null;
      readonly adapterOptions: Readonly<Record<string, never>>;
      readonly acceptedDefinition: Readonly<Record<string, unknown>> | null;
    }
  | ({ readonly adapterId: string } & Exclude<WitnessSourceDefinition, { readonly kind: "github-actions" }> & {
        readonly adapterOptions: Readonly<Record<string, never>>;
      })
  | ({ readonly adapterId: string } & Extract<WitnessSourceDefinition, { readonly kind: "github-actions" }> & {
        readonly adapterOptions: GithubWitnessOptions;
      })
  | {
      readonly adapterId: typeof CODE_DOC_GATE_ID;
      readonly kind: "internal";
      readonly adapterOptions: Readonly<Record<string, never>>;
    };
export const gateGovernanceFields = ["mandatorySignoff", "allowOverride"] as const;
export interface FrozenGateRequirement {
  readonly gateId: string;
  readonly appliesTo: GateAppliesTo;
  readonly witness: FrozenGateWitness;
  readonly subjects?: CompletionGateDeclaration["subjects"];
  readonly bindings?: CompletionGateDeclaration["bindings"];
  readonly independentNode?: true;
  readonly mandatorySignoff?: true;
  readonly allowOverride?: true;
}
export interface FrozenReviewerDeclaration {
  readonly agentId: string;
}
export interface FrozenCompletionContract {
  readonly historicalAcceptance?: {
    readonly sourceGeneration: 1 | 2;
    readonly sourceRevision: number;
    readonly snapshotGap?: true;
  };
  readonly presetSnapshotDigest: string;
  readonly gates: readonly FrozenGateRequirement[];
  readonly closeoutGates: Readonly<Record<CloseoutGate, boolean>>;
  readonly reviewer?: FrozenReviewerDeclaration;
}
export function gateAppliesToSubmission(
  requirement: Pick<FrozenGateRequirement, "appliesTo">,
  submission: { readonly commitSha: string | null; readonly artifacts?: readonly unknown[] },
): boolean {
  if (requirement.appliesTo === "submission") return true;
  if (requirement.appliesTo === "code") return submission.commitSha !== null;
  return (submission.artifacts?.length ?? 0) > 0;
}
/** Repository overrides select a declared source; protocol options belong to its execution kind. */
export interface GateWitnessMappingV1 {
  readonly gateId: string;
  readonly adapter: string;
  readonly appliesTo?: GateAppliesTo;
  readonly branch?: string;
  readonly event?: string;
  readonly coverage?: "exact" | "descendant";
  readonly selection?: "newest";
  readonly mandatorySignoff?: boolean;
  readonly allowOverride?: boolean;
}
function validGithubOptions(value: unknown, fields = hasOnlyFields): value is GithubWitnessOptions {
  return (
    isRecord(value) &&
    fields(value, ["workflows", "branch", "event", "coverage", "selection"]) &&
    Array.isArray(value.workflows) &&
    value.workflows.length > 0 &&
    value.workflows.every(isNonEmptyString) &&
    new Set(value.workflows).size === value.workflows.length &&
    isNonEmptyString(value.branch) &&
    isNonEmptyString(value.event) &&
    (value.coverage === "exact" || value.coverage === "descendant") &&
    value.selection === "newest"
  );
}
function validSource(value: Record<string, unknown>, fields = hasOnlyFields): boolean {
  const common = ["kind", "predicateType", "resultSchema"];
  if (!isNonEmptyString(value.predicateType) || !isRecord(value.resultSchema)) return false;
  switch (value.kind) {
    case "github-actions":
    case "manual":
      return fields(value, common);
    case "command":
      return fields(value, [...common, "entrypoint"]) && isNonEmptyString(value.entrypoint);
    case "external":
      return (
        fields(value, [
          ...common,
          "runnerRole",
          ...(Object.hasOwn(value, "outputBindings") ? ["outputBindings"] : []),
        ]) &&
        isNonEmptyString(value.runnerRole) &&
        (value.outputBindings === undefined ||
          (isRecord(value.outputBindings) &&
            Object.values(value.outputBindings).every((binding) => binding === "run-artifact")))
      );
    default:
      return false;
  }
}
export function validateFrozenCompletionContract(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const fields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  return isRecord(value) &&
    fields(value, [
      "presetSnapshotDigest",
      "gates",
      "closeoutGates",
      ...(Object.hasOwn(value, "reviewer") ? ["reviewer"] : []),
    ]) &&
    (value.historicalAcceptance === undefined ||
      (allowUnknownFields &&
        isRecord(value.historicalAcceptance) &&
        [1, 2].includes(Number(value.historicalAcceptance.sourceGeneration)) &&
        Number.isSafeInteger(value.historicalAcceptance.sourceRevision) &&
        Number(value.historicalAcceptance.sourceRevision) > 0 &&
        (value.historicalAcceptance.snapshotGap === undefined || value.historicalAcceptance.snapshotGap === true))) &&
    (value.reviewer === undefined ||
      (isRecord(value.reviewer) && fields(value.reviewer, ["agentId"]) && isNonEmptyString(value.reviewer.agentId))) &&
    typeof value.presetSnapshotDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.presetSnapshotDigest) &&
    isValidCloseoutGateRecord(value.closeoutGates) &&
    Array.isArray(value.gates) &&
    value.gates.every((gate) =>
      frozenRequirement(gate, fields, allowUnknownFields && value.historicalAcceptance !== undefined),
    ) &&
    new Set(value.gates.map((gate: FrozenGateRequirement) => gate.gateId)).size === value.gates.length
    ? []
    : [
        {
          code: "invalid_submission",
          message: "completionContract must freeze unique gate requirements and their declared sources",
        },
      ];
}
function frozenRequirement(value: unknown, fields: typeof hasOnlyFields, historical = false): boolean {
  if (!isRecord(value)) return false;
  const optional = ["subjects", "bindings", "independentNode", ...gateGovernanceFields].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (
    !fields(value, ["gateId", "appliesTo", "witness", ...optional]) ||
    !isNonEmptyString(value.gateId) ||
    !(gateAppliesTo as readonly unknown[]).includes(value.appliesTo) ||
    !isRecord(value.witness)
  )
    return false;
  for (const flag of ["independentNode", ...gateGovernanceFields])
    if (Object.hasOwn(value, flag) && value[flag] !== true) return false;
  const { adapterId, adapterOptions, ...definition } = value.witness;
  if (definition.kind === "historical")
    return (
      historical &&
      adapterId === null &&
      isRecord(adapterOptions) &&
      fields(adapterOptions, []) &&
      (definition.acceptedDefinition === null || isRecord(definition.acceptedDefinition)) &&
      fields(definition, ["kind", "acceptedDefinition"])
    );
  if (!isNonEmptyString(adapterId) || !isRecord(adapterOptions)) return false;
  if (definition.kind === "internal")
    return (
      value.gateId === CODE_DOC_GATE_ID &&
      adapterId === CODE_DOC_GATE_ID &&
      value.appliesTo === "code" &&
      optional.length === 0 &&
      fields(definition, ["kind"]) &&
      fields(adapterOptions, [])
    );
  if (value.gateId === CODE_DOC_GATE_ID || !validSource(definition, fields)) return false;
  if (definition.kind === "manual" && (value.mandatorySignoff || value.allowOverride)) return false;
  if (definition.kind === "github-actions" ? !validGithubOptions(adapterOptions, fields) : !fields(adapterOptions, []))
    return false;
  if (
    value.subjects !== undefined &&
    value.subjects !== "all-artifacts" &&
    (!Array.isArray(value.subjects) || !value.subjects.every(isNonEmptyString))
  )
    return false;
  return (
    value.bindings === undefined ||
    (isRecord(value.bindings) &&
      Object.values(value.bindings).every(
        (binding) =>
          isRecord(binding) &&
          fields(binding, ["artifact", "pointer"]) &&
          isNonEmptyString(binding.artifact) &&
          typeof binding.pointer === "string",
      ))
  );
}
export function gateWitnessMappingIssues(mappings: readonly GateWitnessMappingV1[]): readonly string[] {
  return mappings.flatMap(({ gateId, adapter, ...options }) => {
    if (adapter === "none" && Object.keys(options).length) return [`settings.gates.${gateId}: none carries no options`];
    if (gateId === CODE_DOC_GATE_ID && adapter !== "none")
      return [`settings.gates.${CODE_DOC_GATE_ID} is internal; map it only to none`];
    return [];
  });
}
export type CompletionContractResolution =
  | { readonly ok: true; readonly contract: FrozenCompletionContract }
  | { readonly ok: false; readonly message: string };
export function resolveCompletionContract(
  declaredGateIds: readonly string[],
  settings: {
    readonly gates: readonly GateWitnessMappingV1[];
    readonly ci: { readonly workflows: readonly string[] };
    readonly closeout?: CloseoutSettingsV1;
  },
  frozen: { readonly digest: string; readonly completion: VerticalCompletionDeclaration },
  taskOverrides?: CloseoutOverridesV1,
): CompletionContractResolution {
  const gates: FrozenGateRequirement[] = [],
    declaration = frozen.completion;
  for (const gateId of new Set(declaredGateIds)) {
    const mapping = settings.gates.find((candidate) => candidate.gateId === gateId),
      declared = declaration.gates[gateId];
    if (mapping?.adapter === "none") continue;
    if (gateId === CODE_DOC_GATE_ID) {
      gates.push({
        gateId,
        appliesTo: "code",
        witness: { adapterId: CODE_DOC_GATE_ID, kind: "internal", adapterOptions: {} },
      });
      continue;
    }
    const sourceId = mapping?.adapter ?? declared?.source,
      source = sourceId === undefined ? undefined : declaration.sources[sourceId];
    if (!source || !sourceId)
      return { ok: false, message: `Gate ${gateId} references undeclared source ${sourceId ?? "<missing>"}.` };
    const appliesTo = mapping?.appliesTo ?? declared?.appliesTo;
    if (!appliesTo) return { ok: false, message: `Gate ${gateId} must declare appliesTo.` };
    const mandatorySignoff = mapping?.mandatorySignoff ?? declared?.mandatorySignoff,
      allowOverride = mapping?.allowOverride ?? declared?.allowOverride;
    if (source.kind === "manual" && (mandatorySignoff || allowOverride))
      return { ok: false, message: `Gate ${gateId}: manual sources already require human testimony.` };
    let witness: FrozenGateWitness;
    if (source.kind === "github-actions") {
      const options = {
        workflows: settings.ci.workflows,
        branch: mapping?.branch ?? "main",
        event: mapping?.event ?? "push",
        coverage: mapping?.coverage ?? "descendant",
        selection: mapping?.selection ?? "newest",
      };
      if (!validGithubOptions(options))
        return {
          ok: false,
          message: `Gate ${gateId} requires registered workflows and valid GitHub execution options.`,
        };
      witness = { adapterId: sourceId, ...source, adapterOptions: options };
    } else {
      if (
        mapping &&
        [mapping.branch, mapping.event, mapping.coverage, mapping.selection].some((item) => item !== undefined)
      )
        return { ok: false, message: `Gate ${gateId}: GitHub options cannot configure ${source.kind}.` };
      witness = { adapterId: sourceId, ...source, adapterOptions: {} };
    }
    gates.push({
      gateId,
      appliesTo,
      witness,
      ...(declared?.subjects === undefined ? {} : { subjects: declared.subjects }),
      ...(declared?.bindings === undefined ? {} : { bindings: declared.bindings }),
      ...(declared?.independentNode ? { independentNode: true } : {}),
      ...(mandatorySignoff ? { mandatorySignoff: true } : {}),
      ...(allowOverride ? { allowOverride: true } : {}),
    });
  }
  return {
    ok: true,
    contract: {
      gates,
      presetSnapshotDigest: frozen.digest,
      closeoutGates: effectiveCloseoutGates(
        settings.closeout ?? {},
        declaredGateIds,
        taskOverrides,
        declaration.closeoutDefaults,
      ),
    },
  };
}
