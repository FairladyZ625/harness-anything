import { deriveRelationId } from "./entity-relation.ts";
import { parseEntityJsonSchema } from "./entity-json-schema.ts";
import type { EntityKindContract } from "./entity-kind-registry.ts";

export type EntityProjectionContract = Pick<
  EntityKindContract,
  "kind" | "schema" | "id" | "relations" | "canonicalProjection"
>;

export interface InterpretedEntityValue {
  readonly kind: string;
  readonly id: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface InterpretedEntityRelation {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly direction: "directed";
  readonly strength: "strong" | "weak";
  readonly origin: "generated" | "inferred";
  readonly state: "active";
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface InterpretedEntityProjection extends InterpretedEntityValue {
  readonly ownerId: string | null;
  readonly workspaceRevision: number;
  readonly relations: readonly InterpretedEntityRelation[];
}

interface CanonicalEventShape {
  readonly schema: string;
  readonly type: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly payload: unknown;
}

export function interpretEntityValue(
  contract: Pick<EntityKindContract, "kind" | "schema" | "id">,
  value: unknown,
  label = `${contract.kind} declaration`,
): InterpretedEntityValue {
  // Pre-budget Squad events are append-only history. Validate that exact old shape without
  // inventing a budget, then carry it to the read boundary where reinstall guidance is available.
  if (contract.kind === "squad" && isEntityRecord(value) && !Object.hasOwn(value, "leaderTurnBudget")) {
    const currentShape = parseEntityJsonSchema(contract.schema, { ...value, leaderTurnBudget: 1 }, label);
    if (!isEntityRecord(currentShape)) throw new Error(`${label} must be an object`);
    const id = currentShape[contract.id.field];
    if (typeof id !== "string") throw new Error(`${label} has no string identity`);
    return { kind: contract.kind, id, value };
  }
  const parsed = parseEntityJsonSchema(contract.schema, value, label);
  if (!isEntityRecord(parsed)) throw new Error(`${label} must be an object`);
  const id = parsed[contract.id.field];
  if (typeof id !== "string") throw new Error(`${label} has no string identity`);
  return { kind: contract.kind, id, value: parsed };
}

export function interpretEntityProjection(
  contract: EntityProjectionContract,
  value: unknown,
  workspaceRevision: number,
  sourcePath: string,
): InterpretedEntityProjection | null {
  return deriveEntityProjection(contract, interpretEntityValue(contract, value), workspaceRevision, sourcePath);
}

export function deriveEntityProjection(
  contract: EntityProjectionContract,
  entity: InterpretedEntityValue,
  workspaceRevision: number,
  sourcePath: string,
): InterpretedEntityProjection | null {
  const declaration = contract.canonicalProjection;
  if (declaration === null) return null;
  if (entity.kind !== contract.kind) throw new Error(`${entity.kind} cannot be projected by ${contract.kind}`);
  const rowId = stringField(entity.value, declaration.row.idField, `${contract.kind} projection identity`),
    ownerId =
      declaration.row.ownerField === null
        ? null
        : stringField(entity.value, declaration.row.ownerField, `${contract.kind} projection owner`);
  if (rowId !== entity.id)
    throw new Error(`${contract.kind} projection identity does not match its EntityKindContract identity`);
  const relations = contract.relations.edges.flatMap((edge, recordIndex) => {
    const projection = edge.projection;
    if (projection === undefined) return [];
    const sourceId = stringField(entity.value, projection.source.field, `${contract.kind} relation source`),
      targetId = stringField(entity.value, projection.target.field, `${contract.kind} relation target`),
      sourceRef = applyRefTemplate(projection.source.refTemplate, sourceId),
      targetRef = applyRefTemplate(projection.target.refTemplate, targetId),
      relationId = deriveRelationId({ source: sourceRef, target: targetRef, type: edge.type, direction: "directed" });
    if (sourceId !== entity.id)
      throw new Error(`${contract.kind} relation source does not match its projected entity identity`);
    return [
      {
        relationId,
        sourceRef,
        targetRef,
        relationType: edge.type,
        direction: projection.direction,
        strength: projection.strength,
        origin: projection.origin,
        state: "active" as const,
        rationale: projection.rationale,
        ownerRef: sourceRef,
        sourcePath,
        recordIndex,
      },
    ];
  });
  return {
    ...entity,
    ownerId,
    workspaceRevision,
    relations,
  };
}

export function interpretEmbeddedEntityProjections(
  contract: EntityProjectionContract,
  event: CanonicalEventShape,
): readonly InterpretedEntityProjection[] {
  const declaration = contract.canonicalProjection;
  if (declaration === null) return [];
  if (!isEntityRecord(event.payload)) throw new Error(`${event.schema}/${event.type} payload must be an object`);
  const payload = event.payload;
  return declaration.embeddedEvents
    .filter((source) => source.schema === event.schema && source.types.includes(event.type))
    .map((source) => {
      const value = payload[source.payloadField];
      const projected = interpretEntityProjection(contract, value, event.workspaceRevision, `event:${event.opId}`);
      if (projected === null) throw new Error(`${contract.kind} embedded projection declaration is unavailable`);
      return projected;
    });
}

function stringField(value: Readonly<Record<string, unknown>>, field: string, label: string): string {
  const selected = value[field];
  if (typeof selected !== "string" || selected.length === 0)
    throw new Error(`${label} field ${field} must be a string`);
  return selected;
}

function applyRefTemplate(template: string, id: string): string {
  if (!template.includes("{id}")) throw new Error(`Entity relation ref template ${template} has no {id} slot`);
  const ref = template.replace("{id}", id);
  if (ref.includes("{id}")) throw new Error(`Entity relation ref template ${template} has more than one {id} slot`);
  return ref;
}

function isEntityRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
