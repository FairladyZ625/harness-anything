import {
  makePgCanonicalEventStore,
  makePgTaskProjection,
  openPgWriterEpoch,
  withWriterEpochFenceDescriptor,
  type PostgresStorageBackendConfig,
  type WriterEpochFenceDescriptor,
} from "@harness-anything/storage/pg";
import { CLOUD_WRITER_ROOT, type CloudWriterRepository } from "./cloud-writer-shard.ts";

/**
 * Opens one repository for a cloud single-writer shard on PostgreSQL: it acquires the repository's
 * writer epoch, then binds the driver-pure PG canonical store and projection to that epoch. No Git
 * follower is attached, so the writer closure stays subprocess-free; publication belongs to the
 * shard's asynchronous outbox.
 */
export function openPgCloudWriterRepository(options: {
  readonly repoId: string;
  readonly storage: PostgresStorageBackendConfig;
  readonly stateRoot: string;
  readonly holderId?: string;
}): CloudWriterRepository & { readonly fence: WriterEpochFenceDescriptor; readonly close: () => Promise<void> } {
  const authority = openPgWriterEpoch({
    stateRoot: options.stateRoot,
    storage: options.storage,
    ...(options.holderId === undefined ? {} : { holderId: options.holderId }),
  });
  try {
    const lease = authority.acquire(options.repoId),
      fence: WriterEpochFenceDescriptor = {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: options.stateRoot,
        repoId: options.repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      },
      store = makePgCanonicalEventStore({
        repoId: options.repoId,
        rootDir: CLOUD_WRITER_ROOT,
        storage: options.storage,
        writerFence: () => fence,
      }),
      projection = makePgTaskProjection({ rootDir: CLOUD_WRITER_ROOT, storage: options.storage, eventStore: store });
    return {
      store,
      projection,
      fence,
      withAppendFence: (operation) => withWriterEpochFenceDescriptor(fence, operation),
      close: async () => {
        projection.close();
        await store.drain();
        authority.close();
      },
    };
  } catch (error) {
    authority.close();
    throw error;
  }
}
