// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { measureDossierHistory } from "./fixtures/g38-dossier-cost.mjs";

test("an indexed fixed dossier delta never reads the preceding source history", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const small = await measureDossierHistory(root, 100);
  const large = await measureDossierHistory(root, 30_000);
  assert.deepEqual(large.counts, small.counts);
  assert.equal(large.counts.indexReads, 1);
  assert.equal(large.counts.rowsDecoded, 4);
  assert.equal(large.counts.claims, 2);
  console.log("DOSSIER_DELTA", JSON.stringify([small, large]));
});
