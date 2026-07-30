import path from "node:path";
import { sha256Text } from "../../../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../layout/index.ts";
import { localLayoutFileSystem } from "../../../local/local-layout-file-system.ts";
import { removeFileDurably, restoreExistingFileInPlaceDurably, writeFileDurably } from "../durable.ts";

export interface RecoverableDocumentTransactionWrite {
  readonly targetPath: string;
  readonly body: string;
}

interface RecoverableDocumentTransactionManifest {
  readonly schema: "recoverable-document-transaction/v1";
  readonly opId: string;
  readonly writeSetDigest: string;
}

export function hasRecoverableDocumentTransaction(rootInput: HarnessLayoutInput, opId: string): boolean {
  return localLayoutFileSystem.exists(manifestPath(rootInput, opId));
}

export function applyRecoverableDocumentTransaction(
  rootInput: HarnessLayoutInput,
  opId: string,
  writes: ReadonlyArray<RecoverableDocumentTransactionWrite>
): void {
  const manifest = transactionManifest(rootInput, opId, writes);
  const target = manifestPath(rootInput, opId);
  const existing = readManifest(target);
  if (existing) {
    if (existing.opId !== manifest.opId || existing.writeSetDigest !== manifest.writeSetDigest) {
      throw new Error(`recoverable document transaction manifest mismatch: ${opId}`);
    }
  } else {
    writeFileDurably(target, `${JSON.stringify(manifest)}\n`);
  }

  const backups = writes.map((write) => ({
    targetPath: write.targetPath,
    existed: localLayoutFileSystem.exists(write.targetPath),
    body: localLayoutFileSystem.exists(write.targetPath) ? localLayoutFileSystem.readText(write.targetPath) : null
  }));
  try {
    for (const [index, write] of writes.entries()) {
      writeFileDurably(write.targetPath, write.body);
      declaredTransactionTestFault(write.targetPath);
      if (index === 0 && process.env.HARNESS_TEST_DECLARED_TRANSACTION_KILLPOINT === "after-first-rename") {
        process.kill(process.pid, "SIGTERM");
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const backup of backups.reverse()) {
      try {
        if (backup.existed && backup.body !== null) {
          restoreExistingFileInPlaceDurably(backup.targetPath, backup.body);
        } else {
          removeFileDurably(backup.targetPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      // Keep the manifest: recovery must replay the declared write set to an
      // all-new state when in-process compensation could not prove all-old.
      throw new AggregateError(
        [error, ...rollbackErrors],
        `recoverable document transaction rollback failed: ${opId}`
      );
    }

    // Once every target is durably back to its old state the failed
    // transaction must no longer be eligible for restart replay.
    removeFileDurably(target);
    throw error;
  }
}

function declaredTransactionTestFault(targetPath: string): void {
  const targetName = path.basename(targetPath);
  if (process.env.HARNESS_TEST_DECLARED_TRANSACTION_FAILURE_AFTER_WRITE === targetName) {
    throw new Error(`injected recoverable document transaction failure after ${targetName}`);
  }
  if (process.env.HARNESS_TEST_DECLARED_TRANSACTION_KILLPOINT_AFTER_WRITE === targetName) {
    process.kill(process.pid, "SIGTERM");
  }
}

export function finalizeRecoverableDocumentTransaction(rootInput: HarnessLayoutInput, opId: string): void {
  const target = manifestPath(rootInput, opId);
  if (localLayoutFileSystem.exists(target)) removeFileDurably(target);
}

function transactionManifest(
  rootInput: HarnessLayoutInput,
  opId: string,
  writes: ReadonlyArray<RecoverableDocumentTransactionWrite>
): RecoverableDocumentTransactionManifest {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const writeSet = writes.map((write) => {
    const relativePath = path.relative(rootDir, write.targetPath).split(path.sep).join("/");
    if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      throw new Error(`recoverable document transaction target escapes root: ${write.targetPath}`);
    }
    return { path: relativePath, bodySha256: sha256Text(write.body) };
  });
  return {
    schema: "recoverable-document-transaction/v1",
    opId,
    writeSetDigest: sha256Text(JSON.stringify(writeSet))
  };
}

function readManifest(filePath: string): RecoverableDocumentTransactionManifest | null {
  if (!localLayoutFileSystem.exists(filePath)) return null;
  const parsed = JSON.parse(localLayoutFileSystem.readText(filePath)) as Partial<RecoverableDocumentTransactionManifest>;
  if (parsed.schema !== "recoverable-document-transaction/v1"
    || typeof parsed.opId !== "string"
    || !/^[a-f0-9]{64}$/u.test(parsed.writeSetDigest ?? "")) {
    throw new Error(`malformed recoverable document transaction manifest: ${filePath}`);
  }
  return parsed as RecoverableDocumentTransactionManifest;
}

function manifestPath(rootInput: HarnessLayoutInput, opId: string): string {
  const root = path.join(resolveHarnessLayout(rootInput).writeJournalRoot, "transactions");
  return path.join(root, `${sha256Text(opId)}.json`);
}
