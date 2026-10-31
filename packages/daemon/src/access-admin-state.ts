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
      mkdirSync(root, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
    },
  };
}

/** Pending permission requests are center-owned workflow state, separate from Keycloak's grant authority. */
export function managedPermissionRequestStore(userRoot: string): {
  readonly read: () => readonly string[];
  readonly write: (lines: readonly string[]) => void;
} {
  const root = path.join(userRoot, "rbac"),
    file = path.join(root, "permission-requests.json");
  return {
    read: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : []),
    write: (lines) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(lines, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
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
  const descriptor = openSync(file, "wx", 0o600);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(descriptor);
  };
  return {
    keep: (credential) => {
      try {
        writeFileSync(descriptor, credential);
      } finally {
        close();
      }
    },
    discard: () => {
      close();
      rmSync(file, { force: true });
    },
  };
}
