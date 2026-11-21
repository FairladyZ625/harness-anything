import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { openAuditRevisionScratch, readAuditRevisionScratch } from "../durable-file.ts";

const revisionBytes = 8;

interface AuditRevisionPage {
  readonly revisions: readonly number[];
  readonly continuation?: string;
}

/** The immutable file is scoped to one time window and ledger cut. Each offset
 * is only a seek hint: its preceding revision must equal the requested floor. */
export function auditWindowRevisionKey(input: {
  readonly scope: readonly (string | number)[];
  readonly afterMs: number;
  readonly beforeMs: number;
  readonly upperRevision: number;
}) {
  const key = sha256Text(JSON.stringify(input));
  const fileFor = (id: string) => path.join(tmpdir(), `ha-audit-revisions-v1-${key}-${id}`);
  return {
    start(afterRevision: number) {
      const id = randomUUID().replaceAll("-", "");
      const file = openAuditRevisionScratch(fileFor(id));
      const buffer = Buffer.alloc(storageReadPolicy.defaultValue.pageSizes.standard * revisionBytes);
      let offset = buffer.writeDoubleLE(afterRevision);
      const append = (revision: number) => {
        offset = buffer.writeDoubleLE(revision, offset);
        if (offset === buffer.length) {
          file.write(buffer);
          offset = 0;
        }
      };
      return {
        append,
        finish() {
          file.seal(buffer.subarray(0, offset));
          return `${id}.0`;
        },
        abort: file.abort,
      };
    },
    read(token: string | undefined, afterRevision: number, limit: number): AuditRevisionPage | null {
      const match = token === undefined ? null : /^([0-9a-f]{32})\.([0-9]+)$/u.exec(token);
      if (match === null) return null;
      const id = match[1]!;
      const offset = Number(match[2]);
      if (!Number.isSafeInteger(offset)) return null;
      const page = readAuditRevisionScratch(fileFor(id), (read, count) => {
        if (offset >= count) return null;
        // Read the anchor, the requested page, and one lookahead in a single window.
        const size = Math.min(limit + 1, count - offset - 1);
        const bytes = Buffer.alloc((size + 1) * revisionBytes);
        read(bytes, offset);
        if (bytes.readDoubleLE() !== afterRevision) return null;
        const revisions = Array.from({ length: Math.min(size, limit) }, (_, index) =>
          bytes.readDoubleLE((index + 1) * revisionBytes),
        );
        return { revisions, ...(size > limit ? { continuation: `${id}.${offset + limit}` } : {}) };
      });
      return page === "missing" ? null : page;
    },
  };
}

// Collect one bounded response while the database streams the sorted revision keys.
// Only multi-page results need a scratch file.
export function collectAuditWindowRevisions(
  key: ReturnType<typeof auditWindowRevisionKey>,
  afterRevision: number,
  limit: number,
) {
  const first: number[] = [];
  let scratch: ReturnType<typeof key.start> | undefined;
  return {
    append(revision: number) {
      if (first.length < limit) {
        first.push(revision);
      } else {
        if (scratch === undefined) {
          scratch = key.start(afterRevision);
          for (const value of first) scratch.append(value);
        }
        scratch.append(revision);
      }
    },
    finish(): AuditRevisionPage {
      if (scratch === undefined) return { revisions: first };
      const page = key.read(scratch.finish(), afterRevision, limit);
      if (page === null) throw new Error("Sealed audit revision file could not be read");
      return page;
    },
    abort() {
      scratch?.abort();
    },
  };
}
