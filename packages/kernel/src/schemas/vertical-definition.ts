import { Schema } from "effect";
import { VerticalCompletionDeclarationSchema } from "./completion-source.ts";
import { RelationTypeSchema } from "./entity-relations.ts";
import { isRecord } from "../domain/write-chain.contract.ts";
import { retiredHostedCiSourceKinds } from "../domain/event-shape-migration-event.ts";
import type { VerticalDeclarationDocumentV1 } from "../domain/vertical-declaration.ts";
import {
  decisionEventDescriptor,
  decisionEventNames,
  decisionInputFields,
  decisionReadSurfaces,
} from "../domain/decision-event-catalog.ts";
import {
  artifactLocatorKinds,
  type ArtifactEntityKindDefinition,
  type VerticalDefinition,
} from "../domain/vertical-definition.ts";

const LocaleSchema = Schema.Literal("zh-CN", "en-US");
const StringArray = Schema.Array(Schema.String);
const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
const RetirementFields = {
  retired: Schema.optional(Schema.Boolean),
  retiredAt: Schema.optional(NonBlankStringSchema),
  reason: Schema.optional(NonBlankStringSchema.pipe(Schema.maxLength(199))),
};

const TemplateSelectionSchema = Schema.Struct({
  slot: Schema.String,
  templateRef: Schema.String,
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema,
  }),
  requiredWhen: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const RepositoryScaffoldCreateModeSchema = Schema.Literal("init", "lazy");

const RepositorySeededDocSchema = Schema.Struct({
  slot: Schema.String,
  templateRef: Schema.String,
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema,
  }),
  requiredWhen: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
  overwrite: Schema.optional(Schema.Boolean),
});

// AGENTS.md three-layer composite slot (ADR-0021 D2/D5).
// L1 base (kernel invariants, deterministic) + L2 vertical overlay (house style,
// deterministic) are composed into a single AGENTS.md; L3 repo specifics are
// appended by the init Configure/Verify step under `repoSpecificsAnchor`, never
// rewriting L1/L2. Composition lives in the CLI materializer, not in the kernel
// 1:1 materialization contract.
const AgentsEntrySchema = Schema.Struct({
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema,
  }),
  baseRef: Schema.String,
  overlayRef: Schema.String,
  repoSpecificsAnchor: Schema.optional(Schema.String),
  overwrite: Schema.optional(Schema.Boolean),
});

const RepositoryScaffoldSchema = Schema.Struct({
  entityRoots: Schema.Array(
    Schema.Struct({
      entityKind: Schema.String,
      path: Schema.String,
      create: RepositoryScaffoldCreateModeSchema,
    }),
  ),
  dirs: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      create: RepositoryScaffoldCreateModeSchema,
    }),
  ),
  seededDocs: Schema.Array(RepositorySeededDocSchema),
  agentsEntry: Schema.optional(AgentsEntrySchema),
});

const VerticalScriptSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("script"),
  command: Schema.String,
  reads: StringArray,
  writes: StringArray,
  inputs: Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
  metadata: Schema.Struct({
    description: Schema.String,
    purpose: Schema.Literal("scaffold", "generate", "transform", "audit"),
    kind: Schema.optional(Schema.Literal("action", "check")),
    contractVersion: Schema.Literal("script-entry/v1"),
    produces: StringArray,
  }),
});

const EntityFieldExtensionSchema = Schema.Struct({
  extends: Schema.Literal("task"),
  field: Schema.String,
  kind: Schema.Literal("enum-facet"),
  values: StringArray.pipe(Schema.minItems(1)),
  default: Schema.Literal(null),
  mutability: Schema.Literal("amendable"),
  projection: Schema.Struct({
    column: Schema.String,
    queryable: Schema.Boolean,
  }),
  reason: Schema.String,
});

const DecisionOptionSchema = Schema.Struct({ id: NonBlankStringSchema, text: NonBlankStringSchema });
const DecisionCriteriaSchema = Schema.Record({ key: NonBlankStringSchema, value: NonBlankStringSchema });
const DecisionQuestionDeclarationSchema = Schema.Union(
  Schema.Struct({
    version: NonBlankStringSchema,
    type: Schema.Literal("noul"),
    prompt: NonBlankStringSchema,
    criteria: Schema.Struct({ true: NonBlankStringSchema, false: NonBlankStringSchema }),
  }),
  Schema.Struct({
    version: NonBlankStringSchema,
    type: Schema.Literal("choice"),
    prompt: NonBlankStringSchema,
    options: Schema.Array(DecisionOptionSchema).pipe(Schema.minItems(2)),
    criteria: DecisionCriteriaSchema,
    abstainOptionId: Schema.optional(NonBlankStringSchema),
  }),
  Schema.Struct({
    version: NonBlankStringSchema,
    type: Schema.Literal("score"),
    prompt: NonBlankStringSchema,
    levels: Schema.Array(DecisionOptionSchema).pipe(Schema.minItems(2)),
    criteria: DecisionCriteriaSchema,
  }),
);

const DecisionWhenSchema = Schema.Struct({
  outcome: Schema.optional(Schema.Array(Schema.Union(Schema.String, Schema.Null))),
  classification: Schema.optional(Schema.Array(Schema.Union(Schema.String, Schema.Null))),
});

const DecisionPointDeclarationSchema = Schema.Struct({
  revision: NonBlankStringSchema,
  on: Schema.Literal(...decisionEventNames),
  when: DecisionWhenSchema,
  input: Schema.Array(Schema.Literal(...decisionInputFields)).pipe(Schema.minItems(1)),
  question: NonBlankStringSchema,
  show: Schema.Array(Schema.Literal(...decisionReadSurfaces)).pipe(Schema.minItems(1)),
});

const VerticalDecisionDeclarationsSchema = Schema.Struct({
  questions: Schema.Record({ key: NonBlankStringSchema, value: DecisionQuestionDeclarationSchema }),
  points: Schema.Record({ key: NonBlankStringSchema, value: DecisionPointDeclarationSchema }),
});

export { artifactLocatorKinds };

const ArtifactRelationSchema = Schema.Struct({
  type: RelationTypeSchema,
  sourceKind: NonBlankStringSchema,
  targetKind: NonBlankStringSchema,
  reads: NonBlankStringSchema,
  strength: Schema.Literal("weak", "strong"),
  rationale: Schema.optional(NonBlankStringSchema),
  decisionClaimRef: NonBlankStringSchema,
  decisionContentPin: Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/u)),
});

/**
 * One declared attribute of an Artifact kind. Attributes are pure values: they cannot name a
 * renderer, a command or a write path, so a new kind never needs a production branch. The supported
 * constructs are the ones a form control can generate; anything else fails the decode at kind
 * creation instead of surprising a caller at import time.
 */
const EntityAttributeDeclarationSchema = Schema.Struct({
  type: Schema.Literal("string", "number", "integer", "boolean"),
  enum: Schema.optional(Schema.Array(NonBlankStringSchema).pipe(Schema.minItems(1))),
  required: Schema.optional(Schema.Boolean),
});

/**
 * An immutable interpretation of a kind's attributes. Publishing a new version appends a row; the
 * bodies already present are never rewritten, so an instance that pinned `version` keeps reading the
 * exact schema it was accepted against even after the kind is renamed or archived.
 */
const EntityKindSchemaVersionSchema = Schema.Struct({
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  attributes: Schema.Record({
    key: Schema.String.pipe(Schema.pattern(/^[a-z][A-Za-z0-9]*$/u)),
    value: EntityAttributeDeclarationSchema,
  }),
});

const ArtifactEntityKindSchema = Schema.Struct({
  ...RetirementFields,
  /** Stable opaque identity. Minted once at creation; survives rename, schema publication and archive. */
  kindId: Schema.String.pipe(Schema.pattern(/^KND-[0-9a-f]{32}$/u)),
  /**
   * The canonical workspace revision this kind row was last accepted at, and therefore the fence a
   * caller writing this kind presents. It is the kind's own accepted revision, not a counter: a write
   * to a sibling kind leaves it untouched, so one kind's acceptance never stales another's fence. An
   * install seed carries none, because a package is not a ledger; the declaring event stamps it.
   */
  revision: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
  /** Qualified name used for selection and install de-duplication only; renaming it changes no ref. */
  id: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)),
  entityType: Schema.Literal("artifact"),
  schemaVersions: Schema.Array(EntityKindSchemaVersionSchema).pipe(Schema.minItems(1)),
  idPrefix: Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9]{0,15}$/u)),
  display: Schema.Struct({
    singular: NonBlankStringSchema,
    plural: NonBlankStringSchema,
  }),
  descriptorSchemaRef: Schema.String.pipe(Schema.pattern(/^schema:\/\/[A-Za-z0-9][A-Za-z0-9/_.@-]*$/u)),
  store: Schema.Struct({
    pathTemplate: NonBlankStringSchema,
  }),
  locatorKinds: Schema.Array(Schema.Literal(...artifactLocatorKinds)).pipe(Schema.minItems(1)),
  relations: Schema.optional(Schema.Array(ArtifactRelationSchema)),
  maturityVocabulary: Schema.optional(Schema.Array(NonBlankStringSchema).pipe(Schema.minItems(1))),
});

export const VerticalDefinitionSchema = Schema.Struct({
  schema: Schema.Literal("vertical-definition/v1"),
  id: Schema.String,
  title: Schema.String,
  version: Schema.String,
  decisions: Schema.optional(VerticalDecisionDeclarationsSchema),
  entityFieldExtensions: Schema.optional(Schema.Array(EntityFieldExtensionSchema)),
  entityKinds: Schema.Array(
    Schema.Union(
      Schema.Struct({
        ...RetirementFields,
        id: Schema.String,
        entityType: Schema.Literal("lifecycle"),
        packageKind: Schema.String,
        contractEntity: Schema.Boolean,
      }),
      Schema.Struct({
        ...RetirementFields,
        id: Schema.String,
        entityType: Schema.Literal("schema"),
        schemaRef: Schema.String,
        contractEntity: Schema.Boolean,
      }),
      ArtifactEntityKindSchema,
    ),
  ).pipe(Schema.minItems(1)),
  contractEntityKinds: StringArray,
  packageScaffolds: Schema.Array(
    Schema.Struct({
      entityKind: Schema.String,
      templateSelections: Schema.Array(TemplateSelectionSchema),
    }),
  ),
  repositoryScaffold: RepositoryScaffoldSchema,
  scripts: Schema.Array(VerticalScriptSchema),
  templateSelections: Schema.Array(TemplateSelectionSchema),
  completion: VerticalCompletionDeclarationSchema,
  projectionSchemas: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      schemaRef: Schema.String,
    }),
  ),
});

// Compile-time anchor: the decoded schema shape and the domain's pure VerticalDefinition type must
// stay mutually assignable. Field drift fails the type check here, not in a runtime alignment test.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type VerticalDefinitionDecoded = Schema.Schema.Type<typeof VerticalDefinitionSchema>;
true satisfies MutuallyAssignable<VerticalDefinitionDecoded, VerticalDefinition>;
type ArtifactEntityKindDecoded = Extract<
  VerticalDefinitionDecoded["entityKinds"][number],
  { readonly entityType: "artifact" }
>;
true satisfies MutuallyAssignable<ArtifactEntityKindDecoded, ArtifactEntityKindDefinition>;
export type ArtifactRelationDefinition = NonNullable<ArtifactEntityKindDefinition["relations"]>[number];
export type EntityKindSchemaVersion = ArtifactEntityKindDefinition["schemaVersions"][number];
export type EntityAttributeDeclaration = EntityKindSchemaVersion["attributes"][string];

/** Decode once, fail closed on every unknown field, and preserve that exact value for compilation consumers. */
export function decodeVerticalDefinition(input: unknown): VerticalDefinition {
  // A retired shape is a migration question, not a schema question. Recognising it here keeps the
  // whole Effect signature (unreadable to the person who owns the repository) out of the answer and
  // names the one command that converts it. Recognition never rewrites the input: the conversion
  // removes CI gates, so it stays an explicit, reviewed migration.
  const retired = retiredVerticalConstructs(input);
  if (retired.length > 0) throw outdatedVerticalDeclaration(retired);
  try {
    const definition = Schema.decodeUnknownSync(VerticalDefinitionSchema, { onExcessProperty: "error" })(input);
    validateDecisionDeclarations(definition);
    return definition;
  } catch (error) {
    throw new Error(`${String(error)}\nFor a pre-completion declaration, run ha migrate completion --help.`, {
      cause: error,
    });
  }
}

export const VERTICAL_DECLARATION_OUTDATED = "vertical_declaration_outdated" as const;

/**
 * The declaration constructs `ha migrate completion` removes, named by their authored path. This is
 * the read-side mirror of that migration's own removal list: the same shapes are detected here and
 * stripped there, in one vocabulary, so neither side can learn a shape the other does not know.
 */
function retiredVerticalConstructs(input: unknown): readonly string[] {
  if (!isRecord(input)) return [];
  const retired: string[] = [];
  if (Object.hasOwn(input, "checkerProfile")) retired.push("checkerProfile");
  const completion = isRecord(input.completion) ? input.completion : null,
    sources = completion && isRecord(completion.sources) ? completion.sources : null;
  for (const [sourceId, source] of Object.entries(sources ?? {}))
    if (isRecord(source) && (retiredHostedCiSourceKinds as readonly string[]).includes(String(source.kind)))
      retired.push(`completion.sources.${sourceId}.kind`);
  const closeoutDefaults = completion && isRecord(completion.closeoutDefaults) ? completion.closeoutDefaults : null;
  if (closeoutDefaults && Object.hasOwn(closeoutDefaults, "codeDoc"))
    retired.push("completion.closeoutDefaults.codeDoc");
  return retired;
}

function outdatedVerticalDeclaration(retired: readonly string[]): Error {
  const fields = retired.join(", "),
    message =
      `This repository's vertical declaration (harness/vertical.json) still uses ${retired.length === 1 ? "a retired construct" : "retired constructs"}: ${fields}. ` +
      "Convert it once, review the candidate, then accept it:\n" +
      "  ha migrate completion --source harness/vertical.json --mode convert --destination <new-file>\n" +
      "  # review <new-file>, place it at harness/vertical.json, then\n" +
      "  ha doc sync --submit --path harness/vertical.json\n" +
      "Run ha migrate completion --help for the preset-package form. The conversion removes the retired " +
      "hosted-CI gates, so it is never applied silently.";
  return Object.assign(new Error(message), { code: VERTICAL_DECLARATION_OUTDATED, retiredFields: [...retired] });
}

function validateDecisionDeclarations(definition: VerticalDefinition): void {
  const decisions = definition.decisions;
  if (!decisions) return;
  for (const [questionId, question] of Object.entries(decisions.questions)) {
    const optionRows = question.type === "choice" ? question.options : question.type === "score" ? question.levels : [];
    if (optionRows.length) {
      const optionIds = optionRows.map(({ id }) => id),
        criteriaIds = Object.keys(question.criteria);
      if (
        new Set(optionIds).size !== optionIds.length ||
        new Set(criteriaIds).size !== criteriaIds.length ||
        optionIds.length !== criteriaIds.length ||
        optionIds.some((id) => !Object.hasOwn(question.criteria, id))
      )
        throw new Error(`Vertical decision question ${questionId} must describe every option exactly once.`);
      if (question.type === "choice" && question.abstainOptionId && !optionIds.includes(question.abstainOptionId))
        throw new Error(`Vertical decision question ${questionId} names an unknown abstainOptionId.`);
    }
  }
  for (const [pointId, point] of Object.entries(decisions.points)) {
    const event = decisionEventDescriptor(point.on);
    if (!event || !event.finalOnly)
      throw new Error(`Vertical decision point ${pointId} references an unsupported or non-final event.`);
    if (!Object.hasOwn(decisions.questions, point.question))
      throw new Error(`Vertical decision point ${pointId} references missing question ${point.question}.`);
    if (new Set(point.input).size !== point.input.length || point.input.some((field) => !(field in event.inputFields)))
      throw new Error(`Vertical decision point ${pointId} requests fields not declared by ${point.on}.`);
    if (point.show.some((surface) => !event.readSurfaces.includes(surface)))
      throw new Error(`Vertical decision point ${pointId} names a read surface not declared by ${point.on}.`);
    if (Object.keys(point.when).some((field) => !(event.whenFields as readonly string[]).includes(field)))
      throw new Error(`Vertical decision point ${pointId} filters a field not declared by ${point.on}.`);
  }
}

/** Parse an authored `harness/vertical.json` materialization back into its decoded document shape. */
export function parseVerticalDeclarationDocument(value: unknown): VerticalDeclarationDocumentV1 {
  if (
    !isRecord(value) ||
    value.schema !== "repository-vertical-declaration/v1" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    throw new Error("repository vertical declaration is invalid");
  return {
    schema: value.schema,
    revision: Number(value.revision),
    definition: decodeVerticalDefinition(value.definition),
  };
}

export function validateVerticalDeclarationRead(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.schema !== "repository-vertical-declaration-read/v1" ||
    !Number.isSafeInteger(value.declarationRevision) ||
    Number(value.declarationRevision) < 1
  )
    return ["repository vertical declaration read envelope is invalid"];
  try {
    decodeVerticalDefinition(value.declaration);
    return [];
  } catch (error) {
    void error;
    return ["repository vertical declaration read declaration is invalid"];
  }
}
