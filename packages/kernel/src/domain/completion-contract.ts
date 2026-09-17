import { hasOnlyFields, hasRequiredFields, isRecord, isNonEmptyString } from "./contract-validation.ts";
import type { ContractValidationIssue } from "./task.ts";

/**
 * The completion contract a submission freezes (dec_59FA45A407F850E2B167A192D7 CH2): the task's declared
 * gates resolved against the repository's harness.yaml witness mappings into one requirement list. The
 * contract rides inside the submission, so submissionDigest covers every requirement and adapter option.
 */

/** The part of a submission a gate judges. */
export const gateAppliesTo = ["submission", "code", "artifacts"] as const;
export type GateAppliesTo = (typeof gateAppliesTo)[number];

/** Witness sources a repository may map a declared gate to in harness.yaml `settings.gates`. */
export const mappedWitnessAdapterIds = ["github-actions", "local-command", "manual-attest"] as const;
export type MappedWitnessAdapterId = (typeof mappedWitnessAdapterIds)[number];

/**
 * Code/doc reconciliation is Harness's own checker: its requirement is built in, never an adapter mapping.
 * A repository may only remove it with `none`.
 */
export const CODE_DOC_GATE_ID = "code-doc-reconciliation";

export type FrozenGateWitness =
  | {
      readonly kind: "adapter";
      readonly adapterId: "github-actions";
      readonly adapterOptions: {
        readonly workflows: readonly string[];
        readonly branch: string;
        readonly event: string;
        /** `descendant` admits runs whose head SHA has the submitted SHA as an ancestor; `exact` does not. */
        readonly coverage: "exact" | "descendant";
        /** Ordering applied before verdict selection; `newest` picks the highest run/attempt first. */
        readonly selection: "newest";
      };
    }
  | {
      readonly kind: "adapter";
      readonly adapterId: "local-command";
      readonly adapterOptions: { readonly command: string };
    }
  | {
      readonly kind: "adapter";
      readonly adapterId: "manual-attest";
      readonly adapterOptions: Readonly<Record<string, never>>;
    }
  | {
      readonly kind: "adapter";
      readonly adapterId: typeof CODE_DOC_GATE_ID;
      readonly adapterOptions: Readonly<Record<string, never>>;
    }
  // Migration-preserved history: the accepted cut predates frozen policy, so no adapter
  // contract can be honestly reconstructed. Read-only — never dispatched, fulfilled,
  // signed off, or overridden.
  | {
      readonly kind: "historical-policy-unavailable";
      readonly reason: "not-recorded";
    };

/**
 * Human responsibility layered orthogonally on an automated witness. Both are present only as `true`,
 * so a contract without them keeps its automated-only meaning and its submission digest.
 * `mandatorySignoff`: an automated pass still needs a human signoff (dual control).
 * `allowOverride`: a recorded automated fail may be waived by the task owner with a rationale.
 * A manual-attest gate is already human-witnessed and accepts neither.
 */
export const gateGovernanceFields = ["mandatorySignoff", "allowOverride"] as const;

export interface FrozenGateRequirement {
  readonly gateId: string;
  readonly appliesTo: GateAppliesTo;
  readonly witness: FrozenGateWitness;
  readonly mandatorySignoff?: true;
  readonly allowOverride?: true;
}

/**
 * The reviewer declaration a submission freezes with its cut (dec_59FA45A407F850E2B167A192D7 CH2 §3):
 * the agent declaration id that owns independent review of this cut. Later settings changes never
 * redirect an in-review cut; cuts frozen before the field fall back to the repository default.
 */
export interface FrozenReviewerDeclaration {
  readonly agentId: string;
}

export interface FrozenCompletionContract {
  readonly gates: readonly FrozenGateRequirement[];
  readonly reviewer?: FrozenReviewerDeclaration;
}

/**
 * Which part of a submitted cut a requirement judges. `submission` applies to every cut;
 * `code` needs a delivery commit; `artifacts` needs at least one accepted artifact anchor.
 * A mixed commit+artifact delivery can carry both kinds at once.
 */
export function gateAppliesToSubmission(
  requirement: Pick<FrozenGateRequirement, "appliesTo">,
  submission: { readonly commitSha: string | null; readonly artifacts?: readonly unknown[] },
): boolean {
  if (requirement.appliesTo === "submission") return true;
  if (requirement.appliesTo === "code") return submission.commitSha !== null;
  return (submission.artifacts?.length ?? 0) > 0;
}

/** One `settings.gates` entry: `none` removes a declared gate; any other adapter witnesses it. */
export interface GateWitnessMappingV1 {
  readonly gateId: string;
  readonly adapter: "none" | MappedWitnessAdapterId;
  readonly appliesTo?: GateAppliesTo;
  readonly branch?: string;
  readonly event?: string;
  readonly command?: string;
  readonly coverage?: "exact" | "descendant";
  readonly selection?: "newest";
  readonly mandatorySignoff?: boolean;
  readonly allowOverride?: boolean;
}

type FrozenAdapterId = Exclude<FrozenGateWitness, { readonly kind: "historical-policy-unavailable" }>["adapterId"];

const adapterOptionFields: Readonly<Record<FrozenAdapterId, readonly string[]>> = {
  "github-actions": ["workflows", "branch", "event", "coverage", "selection"],
  "local-command": ["command"],
  "manual-attest": [],
  [CODE_DOC_GATE_ID]: [],
};

const mappingFields: Readonly<Record<GateWitnessMappingV1["adapter"], readonly string[]>> = {
  none: [],
  "github-actions": ["appliesTo", "branch", "event", "coverage", "selection"],
  "local-command": ["appliesTo", "command"],
  "manual-attest": ["appliesTo"],
};

export function validateFrozenCompletionContract(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const fields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  return isRecord(value) &&
    fields(value, Object.hasOwn(value, "reviewer") ? ["gates", "reviewer"] : ["gates"]) &&
    (value.reviewer === undefined ||
      (isRecord(value.reviewer) && fields(value.reviewer, ["agentId"]) && isNonEmptyString(value.reviewer.agentId))) &&
    Array.isArray(value.gates) &&
    value.gates.every((gate) => frozenRequirement(gate, fields)) &&
    new Set(value.gates.map((gate: FrozenGateRequirement) => gate.gateId)).size === value.gates.length
    ? []
    : [
        {
          code: "invalid_submission",
          message: "completionContract must list unique gate requirements bound to known witness adapters",
        },
      ];
}

function frozenRequirement(value: unknown, fields: typeof hasOnlyFields): boolean {
  const governance = isRecord(value) ? gateGovernanceFields.filter((field) => Object.hasOwn(value, field)) : [];
  if (
    !isRecord(value) ||
    !fields(value, ["gateId", "appliesTo", "witness", ...governance]) ||
    !governance.every((field) => value[field] === true) ||
    !isNonEmptyString(value.gateId) ||
    !(gateAppliesTo as readonly unknown[]).includes(value.appliesTo) ||
    !isRecord(value.witness)
  )
    return false;
  if (value.witness.kind === "historical-policy-unavailable")
    // A preserved-historical requirement never carries governance: it cannot be signed
    // off or overridden, and the internal checker always materializes to an adapter.
    return (
      governance.length === 0 &&
      fields(value.witness, ["kind", "reason"]) &&
      value.witness.reason === "not-recorded" &&
      value.gateId !== CODE_DOC_GATE_ID
    );
  if (
    !fields(value.witness, ["kind", "adapterId", "adapterOptions"]) ||
    value.witness.kind !== "adapter" ||
    !Object.hasOwn(adapterOptionFields, String(value.witness.adapterId)) ||
    !isRecord(value.witness.adapterOptions)
  )
    return false;
  const adapterId = value.witness.adapterId as FrozenAdapterId,
    options = value.witness.adapterOptions,
    internal = adapterId === CODE_DOC_GATE_ID;
  return (
    (governance.length === 0 || (adapterId !== "manual-attest" && !internal)) &&
    fields(options, adapterOptionFields[adapterId]) &&
    internal === (value.gateId === CODE_DOC_GATE_ID) &&
    (!internal || value.appliesTo === "code") &&
    adapterOptionFields[adapterId].every((field) =>
      field === "workflows"
        ? Array.isArray(options.workflows) &&
          options.workflows.length > 0 &&
          options.workflows.every(isNonEmptyString) &&
          new Set(options.workflows).size === options.workflows.length
        : field === "coverage"
          ? options.coverage === "exact" || options.coverage === "descendant"
          : field === "selection"
            ? options.selection === "newest"
            : isNonEmptyString(options[field]),
    )
  );
}

/** Adapter-specific field sets that the flat settings schema cannot express. */
export function gateWitnessMappingIssues(mappings: readonly GateWitnessMappingV1[]): readonly string[] {
  return mappings.flatMap(({ gateId, adapter, mandatorySignoff, allowOverride, ...options }) => {
    const expected = mappingFields[adapter],
      actual = Object.keys(options);
    if ((mandatorySignoff !== undefined || allowOverride !== undefined) && !humanGovernable(adapter))
      return [
        `settings.gates.${gateId} with adapter ${adapter} cannot declare mandatorySignoff or allowOverride; ` +
          "only github-actions and local-command witnesses carry human governance",
      ];
    if (actual.length !== expected.length || !expected.every((field) => actual.includes(field)))
      return [
        `settings.gates.${gateId} with adapter ${adapter} must declare exactly: ${expected.join(", ") || "none"}`,
      ];
    if (adapter === "github-actions") {
      if (options.coverage !== "exact" && options.coverage !== "descendant")
        return [`settings.gates.${gateId}.coverage must be "exact" or "descendant"`];
      if (options.selection !== "newest") return [`settings.gates.${gateId}.selection must be "newest"`];
    }
    if (gateId === CODE_DOC_GATE_ID && adapter !== "none")
      return [`settings.gates.${CODE_DOC_GATE_ID} is witnessed by the internal checker; map it only to none`];
    return [];
  });
}

function humanGovernable(adapter: GateWitnessMappingV1["adapter"]): boolean {
  return adapter === "github-actions" || adapter === "local-command";
}

export type CompletionContractResolution =
  | { readonly ok: true; readonly contract: FrozenCompletionContract }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve a task's declared gates into the one requirement list a submission freezes. The task declares
 * which gates exist (repository mappings for undeclared gates add nothing); the repository mapping supplies
 * the witness; `none` removes the requirement; a declared gate without a mapping is a configuration error.
 */
export function resolveCompletionContract(
  declaredGateIds: readonly string[],
  settings: { readonly gates: readonly GateWitnessMappingV1[]; readonly ci: { readonly workflows: readonly string[] } },
): CompletionContractResolution {
  const gates: FrozenGateRequirement[] = [];
  for (const gateId of new Set(declaredGateIds)) {
    const mapping = settings.gates.find((candidate) => candidate.gateId === gateId);
    if (mapping?.adapter === "none") continue;
    if (gateId === CODE_DOC_GATE_ID) {
      gates.push({
        gateId,
        appliesTo: "code",
        witness: { kind: "adapter", adapterId: CODE_DOC_GATE_ID, adapterOptions: {} },
      });
      continue;
    }
    if (!mapping)
      return unresolved(
        `Task declares completion gate ${gateId}, but harness.yaml settings.gates maps no witness for it; ` +
          "declare its adapter or map it to none.",
      );
    const appliesTo = mapping.appliesTo!,
      governance = {
        ...(mapping.mandatorySignoff === true ? { mandatorySignoff: true as const } : {}),
        ...(mapping.allowOverride === true ? { allowOverride: true as const } : {}),
      };
    if (mapping.adapter === "github-actions") {
      // settings.ci.workflows stays the repository's single GitHub Actions workflow registry.
      if (settings.ci.workflows.length === 0)
        return unresolved(`Gate ${gateId} is witnessed by github-actions, but settings.ci.workflows is empty.`);
      if (mapping.coverage !== "exact" && mapping.coverage !== "descendant")
        return unresolved(`Gate ${gateId} maps github-actions with invalid coverage; use "exact" or "descendant".`);
      if (mapping.selection !== "newest")
        return unresolved(`Gate ${gateId} maps github-actions with invalid selection; use "newest".`);
      gates.push({
        gateId,
        appliesTo,
        witness: {
          kind: "adapter",
          adapterId: "github-actions",
          adapterOptions: {
            workflows: settings.ci.workflows,
            branch: mapping.branch!,
            event: mapping.event!,
            coverage: mapping.coverage,
            selection: mapping.selection,
          },
        },
        ...governance,
      });
    } else if (mapping.adapter === "local-command")
      gates.push({
        gateId,
        appliesTo,
        witness: {
          kind: "adapter",
          adapterId: "local-command",
          adapterOptions: { command: mapping.command! },
        },
        ...governance,
      });
    else
      gates.push({
        gateId,
        appliesTo,
        witness: { kind: "adapter", adapterId: "manual-attest", adapterOptions: {} },
      });
  }
  return { ok: true, contract: { gates } };
}

function unresolved(message: string): CompletionContractResolution {
  return { ok: false, message };
}
