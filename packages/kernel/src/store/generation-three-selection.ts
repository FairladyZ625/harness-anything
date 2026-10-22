import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { openUnactivatedGenerationThreeEventStore, sqliteLedgerPath } from "./sqlite-event-store.ts";
import { publishGenerationThreeActivation, type GenerationThreeActivation } from "./generation-three-activation.ts";

type SelectionInput = { readonly rootInput: HarnessLayoutInput; readonly repoId?: string };

export function readGenerationThreeActivation(input: SelectionInput): GenerationThreeActivation | null {
  return readGenerationThreeActivationAtPath(sqliteLedgerPath(input.rootInput, 3), input.repoId);
}

export function readGenerationThreeActivationAtPath(
  database: string,
  repoId?: string,
  projectionPath?: string,
): GenerationThreeActivation | null {
  const certificatePath = `${database}.activation.json`;
  if (!files.exists(certificatePath)) return null;
  const certificate = JSON.parse(files.readText(certificatePath)) as GenerationThreeActivation;
  const cut = certificate.acceptedCut,
    source = certificate.sourceCut;
  if (
    certificate.schema !== "generation-activation/v3" ||
    certificate.generation !== 3 ||
    typeof certificate.repoId !== "string" ||
    !certificate.repoId ||
    (repoId !== undefined && certificate.repoId !== repoId) ||
    !Number.isSafeInteger(certificate.importedPrefixRevision) ||
    certificate.importedPrefixRevision < 0 ||
    !cut ||
    cut.repoId !== certificate.repoId ||
    !Number.isSafeInteger(cut.revision) ||
    cut.revision < certificate.importedPrefixRevision ||
    !/^sha256:[0-9a-f]{64}$/u.test(cut.headDigest) ||
    (source === null
      ? certificate.importedPrefixRevision !== 0
      : !source ||
        source.repoId !== certificate.repoId ||
        (source.generation !== 1 && source.generation !== 2) ||
        source.revision !== certificate.importedPrefixRevision ||
        !/^sha256:[0-9a-f]{64}$/u.test(source.headDigest))
  )
    throw new TaskEventStoreError("invalid_store", "generation 3 activation certificate differs");
  assertGenerationThreeActivationLedger(database, certificate, projectionPath);
  return certificate;
}

function assertGenerationThreeActivationLedger(
  database: string,
  certificate: GenerationThreeActivation,
  projectionPath?: string,
): void {
  const databaseSize = files.fileSize(database);
  if (databaseSize === null)
    throw new TaskEventStoreError("invalid_store", "generation 3 activation names a missing ledger");
  // SQLite may discard a still-useful WAL when it opens a zero-byte main file.
  if (databaseSize === 0)
    throw new TaskEventStoreError("invalid_store", "generation 3 activation names an empty ledger");
  let ledger: DatabaseSync;
  try {
    ledger = new DatabaseSync(database, { readOnly: true });
  } catch (error) {
    throw new TaskEventStoreError(
      "invalid_store",
      `generation 3 activation ledger cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const hasMetadata = ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ledger_meta'").get(),
      metadata = hasMetadata
        ? ledger.prepare("SELECT repo_id, generation, revision FROM ledger_meta WHERE singleton=1").get()
        : undefined;
    if (!metadata) throw new TaskEventStoreError("invalid_store", "generation 3 activation ledger has no metadata");
    if (metadata.repo_id !== certificate.repoId || Number(metadata.generation) !== 3)
      throw new TaskEventStoreError("invalid_store", "generation 3 activation metadata differs from its ledger");
    const revision = Number(metadata.revision),
      acceptedHeadRow =
        certificate.acceptedCut.revision === 0
          ? undefined
          : ledger
              .prepare("SELECT revision, op_id, digest FROM event WHERE revision=?")
              .get(certificate.acceptedCut.revision),
      acceptedHead = acceptedHeadRow
        ? {
            revision: Number(acceptedHeadRow.revision),
            opId: String(acceptedHeadRow.op_id),
            eventDigest: String(acceptedHeadRow.digest) as `sha256:${string}`,
          }
        : null,
      actualCut = canonicalLedgerCut(certificate.repoId, acceptedHead);
    if (
      revision < certificate.acceptedCut.revision ||
      actualCut.revision !== certificate.acceptedCut.revision ||
      actualCut.headDigest !== certificate.acceptedCut.headDigest
    )
      throw new TaskEventStoreError("invalid_store", "generation 3 activation cut is absent from its ledger");
    if (projectionPath) assertGenerationThreeProjectionDoesNotExceedLedger(projectionPath, revision);
  } finally {
    ledger.close();
  }
}

function assertGenerationThreeProjectionDoesNotExceedLedger(projectionPath: string, ledgerRevision: number): void {
  const projectionSize = files.fileSize(projectionPath);
  if (projectionSize === null || projectionSize === 0) return;
  const projection = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const hasMetadata = projection
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projection_meta'")
      .get();
    if (!hasMetadata) return;
    const metadata = projection
      .prepare("SELECT watermark, scanned_revision FROM projection_meta WHERE singleton=1")
      .get() as { readonly watermark?: number; readonly scanned_revision?: number } | undefined;
    if (metadata && (Number(metadata.watermark) > ledgerRevision || Number(metadata.scanned_revision) > ledgerRevision))
      throw new TaskEventStoreError("invalid_store", "generation 3 ledger revision precedes its persisted projection");
  } finally {
    projection.close();
  }
}

/** A missing certificate is empty only when neither accepted history nor a staged target exists. */
export function selectGenerationThree(input: SelectionInput): 3 {
  if (readGenerationThreeActivation(input)) return 3;
  const layout = resolveHarnessLayout(input.rootInput);
  const history = [1, 2, 3]
    .flatMap((generation) => {
      const database = sqliteLedgerPath(input.rootInput, generation);
      return [database, `${database}.activation.json`, `${database}.import-source.json`];
    })
    .concat([
      path.join(layout.localRoot, "store", "imports", "generation-0.snapshot.json"),
      path.join(layout.localRoot, "cache", "task.sqlite"),
      path.join(layout.authoredRoot, "events"),
      path.join(layout.authoredRoot, "objects"),
    ]);
  if (history.some((candidate) => files.exists(candidate)))
    throw new TaskEventStoreError(
      "invalid_store",
      "generation 3 upgrade is incomplete; run offline conversion before attaching this repository. Run ha migrate ledger --help for backup, conversion, verification and activation.",
    );
  return 3;
}

export function activateEmptyGenerationThree(input: SelectionInput & { readonly repoId: string }): void {
  if (readGenerationThreeActivation(input)) return;
  selectGenerationThree(input);
  const store = openUnactivatedGenerationThreeEventStore({ repoId: input.repoId, rootInput: input.rootInput });
  store.close();
  publishGenerationThreeActivation(input.rootInput, {
    schema: "generation-activation/v3",
    generation: 3,
    repoId: input.repoId,
    sourceCut: null,
    importedPrefixRevision: 0,
    acceptedCut: canonicalLedgerCut(input.repoId, null),
  });
}
