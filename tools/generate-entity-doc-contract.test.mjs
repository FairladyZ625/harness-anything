// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkEntityDocContract,
  normalizeContractLineEndings,
  renderEntityDocContract,
} from "./generate-entity-doc-contract.mjs";

const catalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages/gui/src/renderer/entity-docs.ts",
);

test("the committed generated region matches the live kernel entity contract", async () => {
  await checkEntityDocContract();
});

test("a generated region that drifted from the kernel contract is reported as stale", async () => {
  // An autocrlf checkout hands back CRLF while the renderer emits LF; drift the normalized text.
  const source = normalizeContractLineEndings(readFileSync(catalog, "utf8")),
    rendered = normalizeContractLineEndings(await renderEntityDocContract()),
    drifted = source.replace(rendered, rendered.replace("Object.freeze(", "Object.freeze( "));
  assert.notEqual(drifted, source, "the committed region must contain the rendered contract to drift it");
  await assert.rejects(() => checkEntityDocContract(drifted), /stale; run tools\/generate-entity-doc-contract\.mjs/u);
});
