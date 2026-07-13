import { SessionManifestSchema, type SessionFieldKey } from "../schemas/session-manifest.ts";
import type { EntityFieldContract } from "./field-contracts.ts";
import {
  deferredRegistryFacet,
  readyIdentityProjectionFacets,
  readyStorageLocator,
  typedOnlySemanticDiff
} from "./registry-compiler.ts";
import type { EntityRegistration } from "./registry-contract.ts";

const show = (path: string) => ({ kind: "show" as const, path });
const projection = (path: string, queryable: boolean) => ({ kind: "projection" as const, path, queryable });
const immutable = (reason: string, ...read: EntityFieldContract["read"]): EntityFieldContract => ({
  mutability: "immutable",
  read,
  write: [],
  reason
});
const lifecycle = (reason: string, operation: string, ...read: EntityFieldContract["read"]): EntityFieldContract => ({
  mutability: "lifecycle",
  read,
  write: [{ kind: "lifecycle", operation }],
  reason
});

export const sessionFieldContracts = {
  schema: immutable("schema discriminator is fixed", show("session.schema")),
  sessionId: immutable("session identity is stable", projection("session_id", true), show("session.sessionId")),
  lifecycle: lifecycle("session lifecycle owns state transitions", "session-transition", projection("lifecycle", true), show("session.lifecycle")),
  archiveStatus: lifecycle("snapshot finalization owns archive status", "session-snapshot", projection("archive_status", true), show("session.archiveStatus")),
  runtime: immutable("runtime is capture provenance", projection("runtime", true), show("session.runtime")),
  source: immutable("source is capture provenance", show("session.source")),
  detectedAt: immutable("detection time is capture provenance", show("session.detectedAt")),
  exportedAt: lifecycle("snapshot finalization owns export time", "session-snapshot", projection("exported_at", true), show("session.exportedAt")),
  user: immutable("user is capture provenance", show("session.user")),
  bodyRef: lifecycle("snapshot finalization binds immutable body content", "session-snapshot", projection("body_sha256", true), show("session.bodyRef")),
  snapshot: lifecycle("snapshot finalization owns capture and privacy metadata", "session-snapshot", show("session.snapshot"))
} satisfies Record<SessionFieldKey, EntityFieldContract>;

export const sessionEntityRegistration = {
  kind: "session",
  schema: SessionManifestSchema,
  mutabilityContract: sessionFieldContracts,
  anchors: { entityRef: "session/{sessionId}", anchors: [] },
  dispositionMatrix: {
    entries: {
      retire: { level: "D1", action: "retire", supported: false, writeOpKinds: [], reason: "session lifecycle uses archive" },
      supersede: { level: "D1", action: "supersede", supported: false, writeOpKinds: [], reason: "session snapshots are never overwritten by supersession" },
      invalidate: { level: "D1", action: "invalidate", supported: false, writeOpKinds: [], reason: "session provenance is retained" },
      archive: { level: "D2", action: "archive", supported: true, writeOpKinds: ["doc_write"], reason: "archive preserves manifest and immutable body reference" },
      tombstone: { level: "D3", action: "tombstone", supported: false, writeOpKinds: [], reason: "privacy purge retains audit metadata" },
      "hard-delete": { level: "D4", action: "hard-delete", supported: false, writeOpKinds: [], reason: "session audit metadata is not hard deleted" }
    }
  },
  storageForm: "composite-manifest-blob",
  ...readyIdentityProjectionFacets("session", ["sessionId"], {
    table: "session_projection", idColumn: "session_id", identityField: "sessionId"
  }),
  storageLocator: readyStorageLocator({
    locate: (identity) => ({
      targets: [
        { kind: "document", path: `sessions/${identity.sessionId}.md`, access: "exact" },
        { kind: "content-addressed-blob", access: "exact", referenceField: "bodyRef" }
      ],
      consistencyScope: `entity:session/${identity.sessionId}`
    })
  }),
  mutationContract: deferredRegistryFacet("W4", "OQ-3 action vocabulary is not registered"),
  semanticDiff: typedOnlySemanticDiff("machine-owned session manifests reject transparent canonical writes"),
  rootResolver: { pathTemplate: "sessions/{sessionId}.md", identity: ["sessionId"] },
  projection: {
    table: "session_projection",
    columns: [
      { name: "session_id", field: "sessionId", type: "text", primaryKey: true },
      { name: "lifecycle", field: "lifecycle", type: "text" },
      { name: "archive_status", field: "archiveStatus", type: "text" },
      { name: "runtime", field: "runtime", type: "text" },
      { name: "exported_at", field: "exportedAt", type: "text" },
      { name: "body_sha256", field: "bodyRef.sha256", type: "text" },
      { name: "body_ref_json", field: "bodyRef", type: "json" },
      { name: "snapshot_json", field: "snapshot", type: "json" }
    ]
  },
  documentCodec: {
    decode: (body: string) => {
      if (/^schema:\s*provenance-session\/v1\s*$/mu.test(body)) return undefined;
      if (!body.trimStart().startsWith("{")) return undefined;
      return JSON.parse(body) as unknown;
    },
    encode: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  },
  blob: { referenceField: "bodyRef", store: "content-addressed" }
} satisfies EntityRegistration<SessionFieldKey, "session">;
