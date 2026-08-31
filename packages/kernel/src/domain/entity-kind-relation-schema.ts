import { requireEntityTypeContract } from "./base-entity.ts";
import type { EntityDocumentJsonSchema, EntityJsonObjectSchema } from "./entity-json-schema.ts";
import {
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
} from "./entity-relation.ts";

const relationIdentity = requireEntityTypeContract("relation").id;
const opaqueObject = (): EntityJsonObjectSchema => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
});

export const relationSchema: EntityDocumentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Relation/v1",
  type: "object",
  properties: {
    id: { type: "string", pattern: relationIdentity.pattern },
    kind: { type: "string", const: "relation" },
    ref: { type: "string", pattern: "^relation/rel_[0-9a-f]{16}$" },
    revision: { type: "integer" },
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
    disposition: { type: "string", enum: ["active", "archived", "tombstoned"] },
    provenance: opaqueObject(),
    pinned: { type: "boolean" },
    relationEndpoint: opaqueObject(),
    residency: opaqueObject(),
    source: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    type: { type: "string", enum: relationTypes },
    strength: { type: "string", enum: relationStrengths },
    direction: { type: "string", enum: relationDirections },
    origin: { type: "string", enum: relationOrigins },
    state: { type: "string", enum: relationStates },
    rationale: { type: "string", minLength: 1 },
    replacedBy: { type: "string", pattern: relationIdentity.pattern },
    retirementReason: { type: "string", minLength: 1 },
  },
  required: [
    "id",
    "kind",
    "ref",
    "revision",
    "createdAt",
    "updatedAt",
    "disposition",
    "provenance",
    "pinned",
    "relationEndpoint",
    "residency",
    "source",
    "target",
    "type",
    "strength",
    "direction",
    "origin",
    "state",
    "rationale",
  ],
  additionalProperties: false,
};
