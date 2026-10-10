import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "./sqlite-event-store.ts";
import { publishGenerationThreeActivation, type GenerationThreeActivation } from "./generation-three-activation.ts";

type SelectionInput = { readonly rootInput: HarnessLayoutInput; readonly repoId?: string };

export function readGenerationThreeActivation(input: SelectionInput): GenerationThreeActivation | null {
  const database = sqliteLedgerPath(input.rootInput, 3),
    certificatePath = `${database}.activation.json`;
  if (!files.exists(certificatePath)) return null;
  const certificate = JSON.parse(files.readText(certificatePath)) as GenerationThreeActivation;
  const cut = certificate.acceptedCut,
    source = certificate.sourceCut;
  if (
    certificate.schema !== "generation-activation/v3" ||
    certificate.generation !== 3 ||
    typeof certificate.repoId !== "string" ||
    !certificate.repoId ||
    (input.repoId !== undefined && certificate.repoId !== input.repoId) ||
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
  if (!files.exists(database))
    throw new TaskEventStoreError("invalid_store", "generation 3 activation names a missing ledger");
  return certificate;
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
      path.join(layout.authoredRoot, "events"),
      path.join(layout.authoredRoot, "objects"),
    ]);
  if (history.some((candidate) => files.exists(candidate)))
    throw new TaskEventStoreError(
      "invalid_store",
      "generation 3 upgrade is incomplete; run offline conversion before attaching this repository",
    );
  return 3;
}

export function activateEmptyGenerationThree(input: SelectionInput & { readonly repoId: string }): void {
  if (readGenerationThreeActivation(input)) return;
  selectGenerationThree(input);
  const store = openSqliteEventStore({ repoId: input.repoId, rootInput: input.rootInput, generation: 3 });
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
