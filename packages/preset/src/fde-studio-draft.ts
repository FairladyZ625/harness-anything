// dec_42EB7B8F636C12381A447E52A3/CH2: pure browser-safe FDE domain draft model and deterministic
// cross-reference-preserving rename transforms (zero Node builtins so both preset compiler and gui-fde renderer share one source).
import { canonicalGovernedRelationAuthority } from "@harness-anything/kernel/internal/domain/governed-relation-direction.ts";
import { relationTypes, type RelationType } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";

export type FdeLocale = "zh-CN" | "en-US";

export type FdeAttributeType = "string" | "number" | "integer" | "boolean";

export type FdeLocatorKind = "repository-path" | "url" | "external-key" | "local-path";

export type FdeRelationKind = Extract<RelationType, "relates" | "supersedes">;

export interface FdeEntityAttributeDraft {
  readonly name: string;
  readonly type: FdeAttributeType;
  readonly required: boolean;
  readonly enumValues: readonly string[];
}

export interface FdeEntityKindDraft {
  readonly id: string;
  readonly idPrefix: string;
  readonly singular: string;
  readonly plural: string;
  readonly pathTemplate: string;
  readonly locatorKinds: readonly FdeLocatorKind[];
  readonly maturityVocabulary: readonly string[];
  readonly attributes: readonly FdeEntityAttributeDraft[];
}

export interface FdeEntityRelationDraft {
  readonly type: FdeRelationKind;
  readonly sourceKind: string;
  readonly targetKind: string;
  readonly reads: string;
  readonly strength: "strong" | "weak";
  readonly sourceDecisionRef: string;
  readonly sourceDecisionPin: string;
}

export interface FdeGateFieldDraft {
  readonly name: string;
  readonly type: "string" | "boolean" | "integer" | "number";
  readonly required: boolean;
  readonly constValue?: string | boolean | number;
  readonly minLength?: number;
  readonly pointer: string;
}

export interface FdeGateDraft {
  readonly gateId: string;
  readonly sourceId: string;
  readonly sourceKind: "command" | "manual";
  readonly entrypoint: string;
  readonly artifactPath: string;
  readonly artifactSchema: string;
  readonly predicateType: string;
  readonly fields: readonly FdeGateFieldDraft[];
  readonly positiveSampleJson: string;
  readonly negativeSampleJson: string;
}

export interface FdePresetProfileDraft {
  readonly id: string;
  readonly title: string;
  readonly completionGates: readonly string[];
}

export interface FdeTemplateSlotDraft {
  readonly slot: string;
  readonly materializeAs: string;
  readonly requiredAnchors: readonly string[];
  readonly zhCN: string;
  readonly enUS: string;
}

export interface FdePresetDraft {
  readonly presetId: string;
  readonly title: string;
  readonly presetKind: "template-content" | "process-action";
  readonly outputShape: string;
  readonly defaultProfile: string;
  readonly profiles: readonly FdePresetProfileDraft[];
  readonly templates: readonly FdeTemplateSlotDraft[];
}

export interface FdeAgentDraft {
  readonly id: string;
  readonly name: string;
  readonly role: "worker" | "reviewer" | "coordinator";
  readonly preset: string;
  readonly skills: readonly string[];
  readonly instructions: string;
}

export interface FdeDossierSlotDraft {
  readonly id: string;
  readonly path: string;
  readonly kind: "markdown" | "html";
  readonly title: string;
  readonly summary: string;
  readonly entityKinds: readonly string[];
  readonly requiredAnchors: readonly string[];
  readonly minimumDelta: number;
  readonly periodicMs: number | null;
}

export interface FdeDomainDraft {
  readonly verticalId: string;
  readonly slug: string;
  readonly title: string;
  readonly version: string;
  readonly locale: FdeLocale;
  readonly defaultPresetId: string;
  readonly entities: readonly FdeEntityKindDraft[];
  readonly relations: readonly FdeEntityRelationDraft[];
  readonly gates: readonly FdeGateDraft[];
  readonly presets: readonly FdePresetDraft[];
  readonly agents: readonly FdeAgentDraft[];
  readonly livingDossier: readonly FdeDossierSlotDraft[];
}

const canonicalRelationDecision = canonicalGovernedRelationAuthority.decisions[0]!;

export const DEFAULT_GOVERNED_RELATION_REF = `decision/${canonicalRelationDecision.decisionId}/${canonicalRelationDecision.claimIds[0]!}`;
export const DEFAULT_GOVERNED_RELATION_PIN = canonicalRelationDecision.contentPin;

/** Governed-vertical open subset of Kernel relationTypes (governed-relation-direction.ts). */
export const FDE_RELATION_KINDS: readonly FdeRelationKind[] = Object.freeze(
  relationTypes.filter((type): type is FdeRelationKind => type === "relates" || type === "supersedes"),
);

export const FDE_LOCATOR_KINDS: readonly FdeLocatorKind[] = Object.freeze([
  "repository-path",
  "url",
  "external-key",
  "local-path",
]);

function titleFromVerticalId(verticalId: string): string {
  return verticalId
    .split(/[/-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultBriefSlot(presetId: string): string {
  return `task.${presetId.replaceAll("-", ".")}.brief`;
}

function defaultBriefMaterializeAs(presetId: string): string {
  return `${presetId}-brief.md`;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function rewriteEntrypointPrefix(entrypoint: string, oldPresetId: string, newPresetId: string): string {
  const prefix = `${oldPresetId}/`;
  return entrypoint.startsWith(prefix) ? `${newPresetId}/${entrypoint.slice(prefix.length)}` : entrypoint;
}

function rewritePresetTemplatesForRename(
  templates: readonly FdeTemplateSlotDraft[],
  oldPresetId: string,
  newPresetId: string,
): readonly FdeTemplateSlotDraft[] {
  const oldSlot = defaultBriefSlot(oldPresetId);
  const oldMaterializeAs = defaultBriefMaterializeAs(oldPresetId);
  const nextSlot = defaultBriefSlot(newPresetId);
  const nextMaterializeAs = defaultBriefMaterializeAs(newPresetId);
  return templates.map((template) => ({
    ...template,
    slot: template.slot === oldSlot ? nextSlot : template.slot,
    materializeAs: template.materializeAs === oldMaterializeAs ? nextMaterializeAs : template.materializeAs,
  }));
}

export function createDefaultFdeDraft(input?: {
  readonly verticalId?: string;
  readonly title?: string;
  readonly defaultPresetId?: string;
  readonly locale?: FdeLocale;
}): FdeDomainDraft {
  const verticalId = (input?.verticalId ?? "procurement/review").trim();
  const slug = verticalId.replaceAll("/", "-");
  const title = input?.title?.trim() || titleFromVerticalId(verticalId);
  const defaultPresetId = (input?.defaultPresetId ?? "domain-task").trim();
  const gateId = "deliverable-contract";
  const sourceId = `${slug}/${gateId}`;
  const artifactPath = "artifacts/deliverable.json";
  const artifactSchema = `${verticalId}/deliverable/v1`;
  const predicateType = `${verticalId}/${gateId}/v1`;

  return {
    verticalId,
    slug,
    title,
    version: "1.0.0",
    locale: input?.locale ?? "zh-CN",
    defaultPresetId,
    entities: [
      {
        id: "deliverable",
        idPrefix: "DELIV",
        singular: `${title} Deliverable`,
        plural: `${title} Deliverables`,
        pathTemplate: "entities/deliverables/{id}.json",
        locatorKinds: ["repository-path", "url"],
        maturityVocabulary: ["draft", "in_review", "ready", "archived"],
        attributes: [
          { name: "owner", type: "string", required: true, enumValues: [] },
          { name: "summary", type: "string", required: true, enumValues: [] },
          {
            name: "status",
            type: "string",
            required: true,
            enumValues: ["draft", "in_review", "ready", "archived"],
          },
        ],
      },
    ],
    relations: [
      {
        type: "relates",
        sourceKind: "deliverable",
        targetKind: "task",
        reads: "relates deliverable to",
        strength: "weak",
        sourceDecisionRef: DEFAULT_GOVERNED_RELATION_REF,
        sourceDecisionPin: DEFAULT_GOVERNED_RELATION_PIN,
      },
    ],
    gates: [
      {
        gateId,
        sourceId,
        sourceKind: "command",
        entrypoint: `${defaultPresetId}/verify-deliverable`,
        artifactPath,
        artifactSchema,
        predicateType,
        fields: [
          { name: "schema", type: "string", required: true, constValue: artifactSchema, pointer: "/schema" },
          { name: "owner", type: "string", required: true, minLength: 1, pointer: "/owner" },
          { name: "summary", type: "string", required: true, minLength: 1, pointer: "/summary" },
          { name: "status", type: "string", required: true, constValue: "ready", pointer: "/status" },
          { name: "approved", type: "boolean", required: true, constValue: true, pointer: "/approved" },
        ],
        positiveSampleJson: JSON.stringify(
          {
            schema: artifactSchema,
            owner: "domain-owner",
            summary: `Verified sample package for ${title}.`,
            status: "ready",
            approved: true,
          },
          null,
          2,
        ),
        negativeSampleJson: JSON.stringify(
          {
            schema: artifactSchema,
            owner: "",
            summary: `Incomplete draft for ${title}.`,
            status: "draft",
            approved: false,
          },
          null,
          2,
        ),
      },
    ],
    presets: [
      {
        presetId: defaultPresetId,
        title: titleFromVerticalId(defaultPresetId),
        presetKind: "template-content",
        outputShape: "task-package-artifact",
        defaultProfile: "verified",
        profiles: [
          { id: "verified", title: "Verified Deliverable", completionGates: [gateId] },
          { id: "standard", title: "Standard", completionGates: [gateId] },
          { id: "lightweight", title: "Lightweight", completionGates: [] },
        ],
        templates: [
          {
            slot: defaultBriefSlot(defaultPresetId),
            materializeAs: defaultBriefMaterializeAs(defaultPresetId),
            requiredAnchors: ["## Deliverable Scope", "## Verification Checklist"],
            zhCN: `# ${title} 交付简报\n\n## Deliverable Scope\n\n说明本次交付范围与 \`${artifactPath}\` 结构化内容。\n\n## Verification Checklist\n\n- 确认 \`${artifactPath}\` 通过 \`${gateId}\` 门禁核验。\n`,
            enUS: `# ${title} Brief\n\n## Deliverable Scope\n\nDescribe the scope and expected \`${artifactPath}\` payload.\n\n## Verification Checklist\n\n- Confirm \`${artifactPath}\` satisfies \`${gateId}\`.\n`,
          },
        ],
      },
    ],
    agents: [
      {
        id: "contributor",
        name: `${title} Contributor`,
        role: "worker",
        preset: defaultPresetId,
        skills: ["fde-domain-bootstrap"],
        instructions: `Execute assigned ${title} (${verticalId}) tasks against task_plan.md, author required structured artifacts under artifacts/, and record verifiable evidence before submit.`,
      },
      {
        id: "closeout-reviewer",
        name: `${title} Reviewer`,
        role: "reviewer",
        preset: defaultPresetId,
        skills: [],
        instructions: `Independently review submitted ${title} (${verticalId}) task packages against frozen completion gates and artifact evidence, recording approved or changes_requested.`,
      },
    ],
    livingDossier: [
      {
        id: "project-atlas",
        path: "project-atlas.html",
        kind: "html",
        title: `${title} Project Atlas`,
        summary: `Panorama view of ${verticalId} entities, gates, and active deliverables.`,
        entityKinds: ["task", "decision", "deliverable"],
        requiredAnchors: ["overview", "entities", "gates"],
        minimumDelta: 1,
        periodicMs: null,
      },
      {
        id: "domain-ledger",
        path: "summary.md",
        kind: "markdown",
        title: `${title} Living Summary`,
        summary: `Rolling markdown dossier for ${verticalId}.`,
        entityKinds: ["task", "fact", "deliverable"],
        requiredAnchors: ["overview", "deliverables"],
        minimumDelta: 1,
        periodicMs: 300_000,
      },
    ],
  };
}

/** Atomically rename a preset ID and synchronize `defaultPresetId`, command gate entrypoints, templates, and agents. */
export function renamePresetInDraft(draft: FdeDomainDraft, oldPresetId: string, newPresetId: string): FdeDomainDraft {
  if (oldPresetId === newPresetId) return draft;
  const presets = draft.presets.map((preset) =>
    preset.presetId === oldPresetId
      ? {
          ...preset,
          presetId: newPresetId,
          templates: rewritePresetTemplatesForRename(preset.templates, oldPresetId, newPresetId),
        }
      : preset,
  );
  const gates = draft.gates.map((gate) => ({
    ...gate,
    entrypoint: rewriteEntrypointPrefix(gate.entrypoint, oldPresetId, newPresetId),
  }));
  const agents = draft.agents.map((agent) =>
    agent.preset === oldPresetId ? { ...agent, preset: newPresetId } : agent,
  );
  const defaultPresetId = draft.defaultPresetId === oldPresetId ? newPresetId : draft.defaultPresetId;
  return { ...draft, defaultPresetId, presets, gates, agents };
}

/** Atomically rename a completion gate ID and synchronize all `presets[].profiles[].completionGates` references. */
export function renameGateInDraft(draft: FdeDomainDraft, oldGateId: string, newGateId: string): FdeDomainDraft {
  if (oldGateId === newGateId) return draft;
  const oldSourceId = `${draft.slug}/${oldGateId}`;
  const nextSourceId = `${draft.slug}/${newGateId}`;
  const oldPredicateType = `${draft.verticalId}/${oldGateId}/v1`;
  const nextPredicateType = `${draft.verticalId}/${newGateId}/v1`;
  const gates = draft.gates.map((gate) =>
    gate.gateId === oldGateId
      ? {
          ...gate,
          gateId: newGateId,
          sourceId: gate.sourceId === oldSourceId ? nextSourceId : gate.sourceId,
          predicateType: gate.predicateType === oldPredicateType ? nextPredicateType : gate.predicateType,
        }
      : gate,
  );
  const presets = draft.presets.map((preset) => ({
    ...preset,
    profiles: preset.profiles.map((profile) => ({
      ...profile,
      completionGates: dedupeStrings(
        profile.completionGates.map((gateId) => (gateId === oldGateId ? newGateId : gateId)),
      ),
    })),
  }));
  return { ...draft, gates, presets };
}

/** Atomically rename a profile ID inside a preset and synchronize its `defaultProfile`. */
export function renameProfileInDraft(
  draft: FdeDomainDraft,
  presetId: string,
  oldProfileId: string,
  newProfileId: string,
): FdeDomainDraft {
  if (oldProfileId === newProfileId) return draft;
  const presets = draft.presets.map((preset) => {
    if (preset.presetId !== presetId) return preset;
    return {
      ...preset,
      defaultProfile: preset.defaultProfile === oldProfileId ? newProfileId : preset.defaultProfile,
      profiles: preset.profiles.map((profile) =>
        profile.id === oldProfileId ? { ...profile, id: newProfileId } : profile,
      ),
    };
  });
  return { ...draft, presets };
}

/** Atomically rename an entity kind ID and synchronize `relations` and `livingDossier[].entityKinds`. */
export function renameEntityInDraft(draft: FdeDomainDraft, oldEntityId: string, newEntityId: string): FdeDomainDraft {
  if (oldEntityId === newEntityId) return draft;
  const entities = draft.entities.map((entity) =>
    entity.id === oldEntityId ? { ...entity, id: newEntityId } : entity,
  );
  const relations = draft.relations.map((relation) => ({
    ...relation,
    sourceKind: relation.sourceKind === oldEntityId ? newEntityId : relation.sourceKind,
    targetKind: relation.targetKind === oldEntityId ? newEntityId : relation.targetKind,
  }));
  const livingDossier = draft.livingDossier.map((slot) => ({
    ...slot,
    entityKinds: dedupeStrings(slot.entityKinds.map((kind) => (kind === oldEntityId ? newEntityId : kind))),
  }));
  return { ...draft, entities, relations, livingDossier };
}

/** Update a preset entry by index while keeping `defaultPresetId`, gate entrypoints, templates, agents, and `defaultProfile` synchronized. */
export function updatePresetInDraft(
  draft: FdeDomainDraft,
  presetIndex: number,
  patch: Partial<FdePresetDraft>,
): FdeDomainDraft {
  const existing = draft.presets[presetIndex];
  if (!existing) return draft;
  const nextPresetId = patch.presetId ?? existing.presetId;
  const renamed = patch.presetId !== undefined && patch.presetId !== existing.presetId;
  const nextTemplates =
    patch.templates ??
    (renamed
      ? rewritePresetTemplatesForRename(existing.templates, existing.presetId, nextPresetId)
      : existing.templates);
  const nextProfiles = patch.profiles ?? existing.profiles;
  const requestedDefaultProfile = patch.defaultProfile ?? existing.defaultProfile;
  const nextDefaultProfile =
    nextProfiles.length > 0 && !nextProfiles.some((profile) => profile.id === requestedDefaultProfile)
      ? nextProfiles[0]!.id
      : requestedDefaultProfile;

  const presets = draft.presets.map((preset, idx) =>
    idx === presetIndex
      ? { ...preset, ...patch, presetId: nextPresetId, templates: nextTemplates, defaultProfile: nextDefaultProfile }
      : preset,
  );
  const gates = renamed
    ? draft.gates.map((gate) => ({
        ...gate,
        entrypoint: rewriteEntrypointPrefix(gate.entrypoint, existing.presetId, nextPresetId),
      }))
    : draft.gates;
  const agents = renamed
    ? draft.agents.map((agent) => (agent.preset === existing.presetId ? { ...agent, preset: nextPresetId } : agent))
    : draft.agents;
  const defaultPresetId =
    renamed && (draft.defaultPresetId === existing.presetId || presetIndex === 0)
      ? nextPresetId
      : draft.defaultPresetId;
  return { ...draft, defaultPresetId, presets, gates, agents };
}

/** Update a profile entry by index while keeping the owning preset's `defaultProfile` synchronized. */
export function updateProfileInDraft(
  draft: FdeDomainDraft,
  presetIndex: number,
  profileIndex: number,
  patch: Partial<FdePresetProfileDraft>,
): FdeDomainDraft {
  const preset = draft.presets[presetIndex];
  const existingProfile = preset?.profiles[profileIndex];
  if (!preset || !existingProfile) return draft;
  const nextProfileId = patch.id ?? existingProfile.id;
  const profiles = preset.profiles.map((profile, idx) =>
    idx === profileIndex ? { ...profile, ...patch, id: nextProfileId } : profile,
  );
  const defaultProfile =
    patch.id !== undefined && preset.defaultProfile === existingProfile.id ? nextProfileId : preset.defaultProfile;
  return updatePresetInDraft(draft, presetIndex, { profiles, defaultProfile });
}

/** Update a gate entry by index while keeping `presets[].profiles[].completionGates` and default source/predicate IDs synchronized. */
export function updateGateInDraft(
  draft: FdeDomainDraft,
  gateIndex: number,
  patch: Partial<FdeGateDraft>,
): FdeDomainDraft {
  const existing = draft.gates[gateIndex];
  if (!existing) return draft;
  const renamed = patch.gateId !== undefined && patch.gateId !== existing.gateId;
  const nextGateId = patch.gateId ?? existing.gateId;
  const oldSourceId = `${draft.slug}/${existing.gateId}`;
  const oldPredicateType = `${draft.verticalId}/${existing.gateId}/v1`;
  const nextSourceId =
    patch.sourceId ??
    (renamed && existing.sourceId === oldSourceId ? `${draft.slug}/${nextGateId}` : existing.sourceId);
  const nextPredicateType =
    patch.predicateType ??
    (renamed && existing.predicateType === oldPredicateType
      ? `${draft.verticalId}/${nextGateId}/v1`
      : existing.predicateType);

  const gates = draft.gates.map((gate, idx) =>
    idx === gateIndex
      ? { ...gate, ...patch, gateId: nextGateId, sourceId: nextSourceId, predicateType: nextPredicateType }
      : gate,
  );
  const presets = renamed
    ? draft.presets.map((preset) => ({
        ...preset,
        profiles: preset.profiles.map((profile) => ({
          ...profile,
          completionGates: dedupeStrings(
            profile.completionGates.map((gateId) => (gateId === existing.gateId ? nextGateId : gateId)),
          ),
        })),
      }))
    : draft.presets;
  return { ...draft, gates, presets };
}

/** Update an entity kind by index while keeping `relations` and `livingDossier[].entityKinds` synchronized on rename. */
export function updateEntityInDraft(
  draft: FdeDomainDraft,
  entityIndex: number,
  patch: Partial<FdeEntityKindDraft>,
): FdeDomainDraft {
  const existing = draft.entities[entityIndex];
  if (!existing) return draft;
  const renamed = patch.id !== undefined && patch.id !== existing.id;
  const nextId = patch.id ?? existing.id;
  const entities = draft.entities.map((entity, idx) =>
    idx === entityIndex ? { ...entity, ...patch, id: nextId } : entity,
  );
  if (!renamed) return { ...draft, entities };
  const relations = draft.relations.map((relation) => ({
    ...relation,
    sourceKind: relation.sourceKind === existing.id ? nextId : relation.sourceKind,
    targetKind: relation.targetKind === existing.id ? nextId : relation.targetKind,
  }));
  const livingDossier = draft.livingDossier.map((slot) => ({
    ...slot,
    entityKinds: dedupeStrings(slot.entityKinds.map((kind) => (kind === existing.id ? nextId : kind))),
  }));
  return { ...draft, entities, relations, livingDossier };
}

/** Update `verticalId` and keep derived `slug` and default gate source/predicate prefixes synchronized. */
export function updateVerticalIdInDraft(draft: FdeDomainDraft, nextVerticalId: string): FdeDomainDraft {
  const nextSlug = nextVerticalId.replaceAll("/", "-");
  const oldSlugPrefix = `${draft.slug}/`;
  const oldVerticalPrefix = `${draft.verticalId}/`;
  const gates = draft.gates.map((gate) => ({
    ...gate,
    sourceId: gate.sourceId.startsWith(oldSlugPrefix)
      ? `${nextSlug}/${gate.sourceId.slice(oldSlugPrefix.length)}`
      : gate.sourceId,
    predicateType: gate.predicateType.startsWith(oldVerticalPrefix)
      ? `${nextVerticalId}/${gate.predicateType.slice(oldVerticalPrefix.length)}`
      : gate.predicateType,
  }));
  return { ...draft, verticalId: nextVerticalId, slug: nextSlug, gates };
}
