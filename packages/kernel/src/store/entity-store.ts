import type { HarnessLayoutInput } from "../layout/index.ts";
import {
  compileEntityUpsert,
  isEntityEvent,
  type EntityUpsertBundle,
  type StoredEntityEventV1,
} from "../domain/entity-event.ts";
import { interpretEntityValue } from "../domain/entity-kind-projection.ts";
import { requireEntityStoreKindContract } from "../domain/entity-kind-registry.ts";
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
  const latestEvents = (kind: string): ReadonlyMap<string, StoredEntityEventV1> => {
    const contract = requireEntityStoreKindContract(kind),
      latest = new Map<string, StoredEntityEventV1>();
    for (const event of source.read().events) {
      if (isEntityEvent(event) && event.payload.entityKind === contract.kind) latest.set(event.payload.entityId, event);
    }
    return latest;
  };
  const records = (kind: string): readonly StoredEntity[] => {
    const contract = requireEntityStoreKindContract(kind);
    return [...latestEvents(kind).values()]
      .map((event) => entityEventRecord(event, source, contract))
      .sort((left, right) => left.id.localeCompare(right.id));
  };
  return {
    upsert: compileEntityUpsert,
    get: <T>(kind: string, id: string) => {
      const contract = requireEntityStoreKindContract(kind),
        event = latestEvents(kind).get(id);
      return event === undefined ? null : (entityEventRecord(event, source, contract) as StoredEntity<T>);
    },
    list: <T>(kind: string) => records(kind) as readonly StoredEntity<T>[],
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
  const entity = interpretEntityValue(contract, decoded),
    contractErrors = contract.entityStore.validate?.(entity.value) ?? [];
  if (contractErrors.length) throw new Error(contractErrors.join("; "));
  if (entity.id !== event.payload.entityId)
    throw new Error(`entity declaration blob ${claim.sha256} identity mismatch`);
  return {
    kind: contract.kind,
    id: event.payload.entityId,
    value: entity.value,
    documentPath: claim.path,
    workspaceRevision: event.workspaceRevision,
  };
}
