import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
/** Append-only audit trail of access administration. Authorization never reads it. */
export function managedRbacReceiptJournal(userRoot: string): {
  readonly read: () => readonly string[];
  readonly append: (line: string) => void;
} {
  const root = path.join(userRoot, "rbac"),
    file = path.join(root, "access-receipts.jsonl");
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []),
    append: (line) => {
      /* @gate-identity state-store/runtime-instance.access-admin */ mkdirSync(root, { recursive: true, mode: 0o700 });
      /* @gate-identity state-store/runtime-instance.access-admin */ appendFileSync(file, `${line}\n`, { mode: 0o600 });
    },
  };
}

/** Pending permission requests are center-owned workflow state, separate from the provider's grant authority. */
export function managedPermissionRequestStore(userRoot: string): {
  readonly read: () => readonly string[];
  readonly write: (lines: readonly string[]) => void;
} {
  const root = path.join(userRoot, "rbac"),
    file = path.join(root, "permission-requests.json");
  return {
    read: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : []),
    write: (lines) => {
      /* @gate-identity state-store/runtime-instance.access-admin */ mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      /* @gate-identity state-store/runtime-instance.access-admin */ writeFileSync(
        temporary,
        `${JSON.stringify(lines, null, 2)}\n`,
        { mode: 0o600 },
      );
      /* @gate-identity state-store/runtime-instance.access-admin */ renameSync(temporary, file);
      chmodSync(file, 0o600);
    },
  };
}

/**
 * Reserves a new file only its owner can read, for a credential the caller writes before the
 * external write that makes it real. A path that is already taken throws instead of being
 * overwritten; the descriptor closes exactly once, so `discard` after a `keep` whose write failed
 * removes the reservation instead of failing on the closed descriptor.
 */
export function reserveCredentialFile(file: string): {
  readonly keep: (credential: string) => void;
  readonly discard: () => void;
} {
  const descriptor = /* @gate-identity state-store/runtime-instance.access-admin */ openSync(file, "wx", 0o600);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    /* @gate-identity state-store/runtime-instance.access-admin */ closeSync(descriptor);
  };
  return {
    keep: (credential) => {
      try {
        /* @gate-identity state-store/runtime-instance.access-admin */ writeFileSync(descriptor, credential);
      } finally {
        close();
      }
    },
    discard: () => {
      close();
      /* @gate-identity state-store/runtime-instance.access-admin */ rmSync(file, { force: true });
    },
  };
}
