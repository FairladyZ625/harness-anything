// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseVerticalDeclarationDocument } from "@harness-anything/kernel";
import { validatePresetManifestV3 } from "../src/preset.contract.ts";
import { convertCompletionDeclaration, convertCompletionManifest } from "../src/completion-migration.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/completion-migration/${name}.json`, import.meta.url), "utf8"));

test("retired repository declaration points to the explicit migration without accepting it", () => {
  assert.throws(() => parseVerticalDeclarationDocument(fixture("repository-before")), /ha migrate completion --help/u);
  assert.doesNotThrow(() => parseVerticalDeclarationDocument(fixture("repository-after")));
});

test("retired installed preset points to the explicit migration without accepting it", () => {
  const errors = validatePresetManifestV3(fixture("gui-development")).join("; ");
  assert.match(errors, /ha migrate completion --help/u);
  assert.match(errors, /profiles\[0\] contains unknown field "checkerProfile"/u);
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

test("completion migration strips the retired closeout default from an old repository declaration", () => {
  const historical = structuredClone(fixture("repository-after"));
  historical.definition.completion.closeoutDefaults.codeDoc = true;
  assert.throws(() => parseVerticalDeclarationDocument(historical), /ha migrate completion --help/u);
  assert.deepEqual(convertCompletionDeclaration(historical), fixture("repository-after"));
});

test("completion migration strips the retired codeDoc closeout override from a profile", () => {
  // An object installed before 2026-10-21 froze `codeDoc` into its profile overrides; the narrowed
  // vocabulary now rejects it, so the explicit migration must remove the key instead of forwarding it.
  const historical = structuredClone(fixture("gui-development"));
  historical.profiles[0].closeoutOverrides = { codeDoc: true, review: false };
  assert.match(validatePresetManifestV3(historical).join("; "), /closeoutOverrides/u);
  const converted = convertCompletionManifest(historical) as {
    readonly profiles: readonly { readonly closeoutOverrides?: Record<string, boolean> }[];
  };
  assert.deepEqual(converted.profiles[0]!.closeoutOverrides, { review: false });
  const onlyRetired = structuredClone(fixture("gui-development"));
  onlyRetired.profiles[0].closeoutOverrides = { codeDoc: true };
  assert.equal(
    Object.hasOwn(
      (convertCompletionManifest(onlyRetired) as { readonly profiles: readonly Record<string, unknown>[] })
        .profiles[0]!,
      "closeoutOverrides",
    ),
    false,
  );
});

test("unrelated profile errors keep field diagnostics without a completion migration hint", () => {
  const current = fixture("gui-development");
  for (const profile of current.profiles) delete profile.checkerProfile;
  assert.deepEqual(validatePresetManifestV3(current), []);
  current.profiles[0].unexpected = true;
  current.defaultProfile = "missing";
  const errors = validatePresetManifestV3(current).join("; ");
  assert.match(errors, /profiles\[0\] contains unknown field "unexpected"/u);
  assert.match(errors, /"defaultProfile" must match the id of a declared profile/u);
  assert.doesNotMatch(errors, /ha migrate completion/u);
});
