import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** Internal capability: the physical owner's parent retains the OS lock until database close/exit. */
export interface PGliteDirectoryMutexProof {
  readonly directory: string;
  readonly live: Int32Array;
}
const borrowed = new Map<string, PGliteDirectoryMutexProof>();
export function installPGliteDirectoryMutex(proof: PGliteDirectoryMutexProof | undefined): void {
  if (proof) borrowed.set(proof.directory, proof);
}

/** SQLite supplies only a portable kernel file lock here, never a second canonical data store.
 * Keep its inode after close: unlinking a lock file races a process already waiting on that inode.
 */
export function acquirePGliteDirectoryMutex(dataDir: string | undefined) {
  if (dataDir === undefined || (/^[a-z][a-z0-9+.-]*:\/\//iu.test(dataDir) && !dataDir.startsWith("file://")))
    return { proof: undefined, close: () => undefined };
  const path = dataDir.startsWith("file://") ? fileURLToPath(dataDir) : dataDir;
  /* @gate-identity state-store/legacy.9bcd1c8ef3c528d7 */ mkdirSync(path, {
    recursive: true,
  });
  const directory = realpathSync(path),
    parent = borrowed.get(directory);
  if (parent) {
    if (Atomics.load(parent.live, 0) !== 1)
      throw Object.assign(new Error("Embedded database directory owner closed"), { code: "pglite_owner_unavailable" });
    return { proof: parent, close: () => undefined };
  }
  const database = /* @gate-identity state-store/legacy.2a90d13db9910dfe */ new DatabaseSync(
    `${directory}.harness-owner-lock`,
  );
  try {
    /* @gate-identity state-store/legacy.47e5ee2be3d92df3 */ database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    throw error;
  }
  const live = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(live, 0, 1);
  return {
    proof: { directory, live },
    close() {
      if (Atomics.exchange(live, 0, 0) !== 1) return;
      database.close();
    },
  };
}
