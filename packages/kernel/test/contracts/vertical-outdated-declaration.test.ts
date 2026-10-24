// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeVerticalDefinition } from "../../src/schemas/vertical-definition.ts";

// The exact shapes `ha migrate completion` converts, taken from the same fixtures that pin that
// migration. A reader must name them instead of dumping the decoded Effect Schema signature.
const current = JSON.parse(
  readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const witness = (kind: unknown) => ({
  kind,
  predicateType: "ci/v1",
  resultSchema: { type: "object" },
});

function completionDeclaration(sources: Record<string, unknown>) {
  return {
    sources,
    gates: Object.fromEntries(Object.keys(sources).map((id) => [id, { source: id, appliesTo: "code" }])),
    closeoutDefaults: {},
  };
}

const outdated = (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, "vertical_declaration_outdated", String(error));
  const message = (error as Error).message;
  assert.match(message, /ha migrate completion --source/u);
  // The whole point of the code is that the schema dump no longer reaches the user: the old reader
  // pasted the decoded Effect Schema signature after the first newline.
  assert.doesNotMatch(message, /readonly schema: "vertical-definition\/v1"/u);
  return true;
};

test("a retired checkerProfile declaration is rejected with its migration command, not a schema dump", () => {
  assert.throws(() => decodeVerticalDefinition({ ...current, checkerProfile: "software-coding-standard" }), outdated);
  assert.throws(() => decodeVerticalDefinition({ ...current, checkerProfile: "software-coding-standard" }), {
    message: /checkerProfile/u,
  });
});

test("a retired hosted-CI completion source is named together with the migration command", () => {
  const definition = {
    ...current,
    completion: completionDeclaration({ ci: witness("github-actions") }),
  };
  assert.throws(() => decodeVerticalDefinition(definition), outdated);
  assert.throws(() => decodeVerticalDefinition(definition), { message: /completion\.sources\.ci\.kind/u });
});

test("every retired construct the completion migration removes is recognised the same way", () => {
  const retiredDefaults = {
    ...current,
    completion: {
      sources: { manual: { kind: "manual", predicateType: "harness/attestation/v1", resultSchema: {} } },
      gates: {},
      closeoutDefaults: { codeDoc: true },
    },
  };
  assert.throws(() => decodeVerticalDefinition(retiredDefaults), outdated);
  assert.throws(() => decodeVerticalDefinition(retiredDefaults), { message: /closeoutDefaults\.codeDoc/u });
});

test("recognition rejects the retired shape; it never silently converts it", () => {
  const source = { ...current, checkerProfile: "software-coding-standard" };
  const before = structuredClone(source);
  assert.throws(() => decodeVerticalDefinition(source), outdated);
  assert.deepEqual(source, before, "the decoder must not rewrite its input into a migrated declaration");
});

test("the current declaration keeps decoding unchanged", () => {
  const decoded = decodeVerticalDefinition(current);
  assert.equal(decoded.id, "software/coding");
  assert.equal(Object.hasOwn(decoded, "checkerProfile"), false);
});
