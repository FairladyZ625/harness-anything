// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

const declaration = {
  id: "external-document",
  entityType: "artifact",
  idPrefix: "EXTDOC",
  display: { singular: "External Document", plural: "External Documents" },
  descriptorSchemaRef: "schema://external-document/v1",
  store: { pathTemplate: "entities/external-documents/{id}.json" },
  locatorKinds: ["repository-path", "url", "external-key"],
  attributes: { category: { type: "string", enum: ["meeting-minutes", "technical-note"] } },
};

test("Artifact kind commands project onto the GUI's closed center actions", () => {
  const list = parseThinCommand(["vertical", "kind", "list"]),
    show = parseThinCommand(["vertical", "kind", "show", "external-document"]),
    published = parseThinCommand([
      "vertical",
      "kind",
      "publish-schema",
      "external-document",
      "--attributes",
      '{"category":{"type":"string","enum":["meeting-minutes"]},"owner":{"type":"string"}}',
      "--expected-version",
      "4",
    ]),
    retired = parseThinCommand([
      "vertical",
      "kind",
      "retire",
      "entity-kind/KND-0123456789abcdef0123456789abcdef",
      "--reason",
      "Superseded by a narrower kind",
      "--expected-version",
      "7",
    ]);
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(show.ok, true, JSON.stringify(show));
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(retired.ok, true, JSON.stringify(retired));
  if (list.ok) assert.deepEqual(list.command.action, { kind: "vertical-kind-list" });
  if (show.ok) assert.deepEqual(show.command.action, { kind: "vertical-kind-show", kindId: "external-document" });
  if (published.ok)
    assert.deepEqual(published.command.action, {
      kind: "vertical-kind-publish-schema",
      kindId: "external-document",
      attributes: { category: { type: "string", enum: ["meeting-minutes"] }, owner: { type: "string" } },
      expectedVersion: 4,
    });
  if (retired.ok)
    assert.deepEqual(retired.command.action, {
      kind: "vertical-kind-retire",
      kindId: "entity-kind/KND-0123456789abcdef0123456789abcdef",
      reason: "Superseded by a narrower kind",
      expectedVersion: 7,
    });
});

test("Artifact kind upsert reads one declaration file into the action the daemon validates", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-vertical-kind-cli-"));
  try {
    writeFileSync(path.join(root, "external-document.json"), JSON.stringify(declaration));
    const fromFile = parseThinCommand(
      ["vertical", "kind", "upsert", "--from-file", "external-document.json", "--expected-version", "0"],
      root,
    );
    assert.equal(fromFile.ok, true, JSON.stringify(fromFile));
    if (fromFile.ok)
      assert.deepEqual(fromFile.command.action, {
        kind: "vertical-kind-upsert",
        kindId: "external-document",
        declaration,
        expectedVersion: 0,
      });
    const inline = parseThinCommand([
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      JSON.stringify({ ...declaration, id: "field-note" }),
      "--expected-version",
      "0",
    ]);
    assert.equal(inline.ok, true, JSON.stringify(inline));
    if (inline.ok) assert.equal(inline.command.action.kindId, "field-note");
    const renamed = parseThinCommand([
      "vertical",
      "kind",
      "upsert",
      "--kind",
      "entity-kind/KND-0123456789abcdef0123456789abcdef",
      "--declaration",
      JSON.stringify({ ...declaration, id: "renamed-document" }),
      "--expected-version",
      "9",
    ]);
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    if (renamed.ok) assert.equal(renamed.command.action.kindId, "entity-kind/KND-0123456789abcdef0123456789abcdef");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact kind command failures name the fence and the declaration repair", () => {
  const missingFence = parseThinCommand(["vertical", "kind", "retire", "external-document", "--reason", "done"]),
    missingShow = parseThinCommand(["vertical", "kind", "show"]),
    missingFile = parseThinCommand([
      "vertical",
      "kind",
      "upsert",
      "--from-file",
      "missing.json",
      "--expected-version",
      "0",
    ]),
    malformedFile = parseThinCommand([
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      "{not-json}",
      "--expected-version",
      "0",
    ]),
    both = parseThinCommand([
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      JSON.stringify(declaration),
      "--from-file",
      "external-document.json",
      "--expected-version",
      "0",
    ]),
    noDeclaration = parseThinCommand(["vertical", "kind", "upsert", "--expected-version", "0"]),
    unknown = parseThinCommand(["vertical", "kind", "list", "--unknown", "x"]);
  assert.equal(missingFence.ok ? "ok" : missingFence.code, "missing_field");
  if (!missingFence.ok) assert.match(missingFence.nextAction, /--expected-version 0/u);
  // The contract path stops before the positional, so a bare `show` resolves to this command and the
  // parser names the missing Kind instead of falling through to the unsupported-command hint.
  assert.equal(missingShow.ok ? "ok" : missingShow.code, "missing_field");
  assert.equal(missingFile.ok ? "ok" : missingFile.code, "invalid_field");
  if (!missingFile.ok) assert.match(missingFile.nextAction, /could not be read/u);
  assert.equal(malformedFile.ok ? "ok" : malformedFile.code, "invalid_field");
  if (!malformedFile.ok) assert.equal(malformedFile.nextAction, "--declaration must be one JSON object.");
  assert.equal(both.ok ? "ok" : both.code, "invalid_field");
  assert.equal(noDeclaration.ok ? "ok" : noDeclaration.code, "missing_field");
  assert.equal(unknown.ok ? "ok" : unknown.code, "unknown_field");
});
