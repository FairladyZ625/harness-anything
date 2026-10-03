import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";

/** Display/provenance mapping supplied by Keycloak, never a permission record. */
export interface PersonProfile {
  readonly personId: string;
  readonly displayName: string;
  readonly primaryEmail?: string;
}

export const PERSON_V1_SCHEMA: EntityDocumentJsonSchema<PersonProfile> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "person/v1",
  type: "object",
  additionalProperties: false,
  required: ["personId", "displayName"],
  properties: {
    personId: { type: "string", minLength: 1 },
    displayName: { type: "string", minLength: 1 },
    primaryEmail: { type: "string", minLength: 1 },
  },
};
