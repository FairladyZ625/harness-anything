import type { HarnessLayoutInput } from "../layout/index.ts";
import { parseEntityJsonSchema } from "../domain/entity-json-schema.ts";
import {
  compileEntityUpsert,
  isEntityEvent,
  type EntityUpsertBundle,
  type StoredEntityEventV1,
} from "../domain/entity-event.ts";
import { isTaskEvent } from "../domain/doc-sync.contract.ts";
import { entityDocumentPath, requireEntityStoreKindContract } from "../domain/entity-kind-registry.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { publicationRefs } from "./task-event-store-git-refs.ts";
import { readBlobAt, readHeadAt, readStream } from "./task-event-store-reads.ts";
import type { CanonicalEventStore } from "./task-event-store-types.ts";

export interface StoredEntity<T = unknown> {
  readonly kind: string;
  readonly id: string;
  readonly value: T;
  readonly documentPath: string;
  readonly workspaceRevision: number;
}

export interface EntityStore {
  readonly upsert: (input: Parameters<typeof compileEntityUpsert>[0]) => EntityUpsertBundle;
  readonly get: <T = unknown>(kind: string, id: string) => StoredEntity<T> | null;
  readonly list: <T = unknown>(kind: string) => readonly StoredEntity<T>[];
}

type EntityEventSource = Pick<CanonicalEventStore, "read" | "readContentBlob">;

export function createEntityStore(source: EntityEventSource): EntityStore {
  const records = (kind: string): readonly StoredEntity[] => {
    const contract = requireEntityStoreKindContract(kind),
      latest = new Map<string, ReturnType<typeof entityEventRecord>>();
    for (const event of source.read().events) {
      if (isEntityEvent(event) && event.payload.entityKind === contract.kind)
        latest.set(event.payload.entityId, entityEventRecord(event, source, contract));
      if (contract.kind === "execution" && isTaskEvent(event) && "execution" in event.payload)
        latest.set(
          event.payload.execution.executionId,
          taskEventRecord(event.payload.execution, event.workspaceRevision, contract),
        );
      if (
        contract.kind === "review" &&
        isTaskEvent(event) &&
        (event.type === "review_recorded" || event.type === "review_consent_recorded")
      )
        latest.set(
          event.payload.review.reviewId,
          taskEventRecord(event.payload.review, event.workspaceRevision, contract),
        );
    }
    return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id));
  };
  return {
    upsert: compileEntityUpsert,
    get: <T>(kind: string, id: string) =>
      (records(kind).find((record) => record.id === id) as StoredEntity<T> | undefined) ?? null,
    list: <T>(kind: string) => records(kind) as readonly StoredEntity<T>[],
  };
}

function taskEventRecord(
  value: unknown,
  workspaceRevision: number,
  contract: ReturnType<typeof requireEntityStoreKindContract>,
): StoredEntity {
  const parsed = parseEntityJsonSchema(contract.schema, value, `${contract.kind} declaration`),
    id = (parsed as Record<string, unknown>)[contract.id.field];
  if (typeof id !== "string") throw new Error(`${contract.kind} lifecycle event has no string identity`);
  return {
    kind: contract.kind,
    id,
    value: parsed,
    documentPath: entityDocumentPath(contract, id),
    workspaceRevision,
  };
}

export function openEntityStore(rootInput: HarnessLayoutInput): EntityStore {
  const ledger = resolveLedgerGitLayout(rootInput),
    canonical = publicationRefs(ledger.rootDir, "refs/heads/__entity-read__").canonical;
  if (canonical === null)
    return createEntityStore({
      read: () => ({ schema: "canonical-event-stream/v1", revision: 0, events: [] }),
      readContentBlob: () => null,
    });
  return createEntityStore({
    read: () => readStream(ledger, canonical, readHeadAt(ledger, canonical)),
    readContentBlob: (sha256) => readBlobAt(ledger, canonical, sha256),
  });
}

function entityEventRecord(
  event: StoredEntityEventV1,
  source: EntityEventSource,
  contract: ReturnType<typeof requireEntityStoreKindContract>,
): StoredEntity {
  const claim = event.payload.declarationDocumentClaim,
    bytes = source.readContentBlob(claim.sha256);
  if (!bytes || bytes.byteLength !== claim.size)
    throw new Error(`entity declaration blob ${claim.sha256} is unavailable`);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`entity declaration blob ${claim.sha256} is not UTF-8`);
  }
  if (sha256Text(body) !== claim.sha256) throw new Error(`entity declaration blob ${claim.sha256} hash mismatch`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error(`entity declaration blob ${claim.sha256} is not JSON`);
  }
  const value = parseEntityJsonSchema(contract.schema, decoded, `${contract.kind} declaration`);
  const contractErrors = contract.entityStore.validate?.(value) ?? [];
  if (contractErrors.length) throw new Error(contractErrors.join("; "));
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Readonly<Record<string, unknown>>)[contract.id.field] !== event.payload.entityId
  )
    throw new Error(`entity declaration blob ${claim.sha256} identity mismatch`);
  return {
    kind: contract.kind,
    id: event.payload.entityId,
    value,
    documentPath: claim.path,
    workspaceRevision: event.workspaceRevision,
  };
}
