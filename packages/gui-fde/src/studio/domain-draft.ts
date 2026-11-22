import { relationTypes, type RelationType } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";

export type FdeLocale = "zh-CN" | "en-US";

export type FdeAttributeType = "string" | "number" | "integer" | "boolean";

export type FdeLocatorKind = "repository-path" | "url" | "external-key" | "local-path";

export type FdeRelationKind = RelationType;

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

export const FDE_RELATION_KINDS: readonly FdeRelationKind[] = relationTypes;

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
        type: "evidences",
        sourceKind: "deliverable",
        targetKind: "task",
        reads: "evidences delivery of",
        strength: "strong",
        sourceDecisionRef: "decision/dec_42EB7B8F636C12381A447E52A3/CH2",
        sourceDecisionPin: "sha256:29118aba05892be46bac27c5865c4823470e09f3035dc15d396bd8589810f3da",
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
            slot: `task.${defaultPresetId.replaceAll("-", ".")}.brief`,
            materializeAs: `${defaultPresetId}-brief.md`,
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
