// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseVerticalDeclarationDocument } from "@harness-anything/kernel";
import { validatePresetManifestV3 } from "../src/preset.contract.ts";
import { convertCompletionDeclaration } from "../src/completion-migration.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/completion-migration/${name}.json`, import.meta.url), "utf8"));

test("retired repository declaration points to the explicit migration without accepting it", () => {
  assert.throws(() => parseVerticalDeclarationDocument(fixture("repository-before")), /ha migrate completion --help/u);
  assert.doesNotThrow(() => parseVerticalDeclarationDocument(fixture("repository-after")));
});

test("retired installed preset points to the explicit migration without accepting it", () => {
  assert.match(validatePresetManifestV3(fixture("gui-development")).join("; "), /ha migrate completion --help/u);
});

test("bare vertical conversion preserves explicit completion and rejects unmapped missing declarations", () => {
  const old = fixture("repository-before").definition;
  const current = fixture("repository-after").definition;
  assert.deepEqual(convertCompletionDeclaration(old), current);
  const explicit = { ...current, completion: { sources: {}, gates: {}, closeoutDefaults: { review: true } } };
  assert.deepEqual(convertCompletionDeclaration({ ...explicit, checkerProfile: "software-coding-standard" }), explicit);
  assert.deepEqual(convertCompletionDeclaration(explicit), explicit);
  assert.throws(() => convertCompletionDeclaration({ ...old, id: "custom/vertical" }), /no historical/u);
  assert.throws(
    () => convertCompletionDeclaration({ ...old, checkerProfile: "custom" }),
    /No completion migration mapping/u,
  );
});
