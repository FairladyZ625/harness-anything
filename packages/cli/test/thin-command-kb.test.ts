// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

const ROOT = "/tmp/kb-cli-test" as never;

test("Thin CLI parses ha kb catalog, outline, read, put, and mount commands accurately", () => {
  const catalog = parseThinCommand(
    [
      "kb",
      "catalog",
      "--scope",
      "all",
      "--domain",
      "architecture",
      "--tag",
      "s1",
      "--include-archived",
      "--limit",
      "10",
      "--json",
    ],
    ROOT,
  );
  assert.equal(catalog.ok, true);
  if (catalog.ok) {
    assert.equal(catalog.command.json, true);
    assert.equal(catalog.command.method, "repo.task.read");
    assert.deepEqual(catalog.command.action, {
      kind: "kb-catalog",
      scope: "all",
      domain: "architecture",
      tag: "s1",
      includeArchived: true,
      limit: 10,
    });
  }

  const outline = parseThinCommand(["kb", "outline", "doc_spec_01", "--scope", "shared"], ROOT);
  assert.equal(outline.ok, true);
  if (outline.ok) {
    assert.equal(outline.command.method, "repo.task.read");
    assert.deepEqual(outline.command.action, {
      kind: "kb-outline",
      docId: "doc_spec_01",
      scope: "shared",
    });
  }

  const readSection = parseThinCommand(["kb", "read", "doc_spec_01", "--section", "1.2 Center-Shared"], ROOT);
  assert.equal(readSection.ok, true);
  if (readSection.ok) {
    assert.deepEqual(readSection.command.action, {
      kind: "kb-read",
      docId: "doc_spec_01",
      section: "1.2 Center-Shared",
    });
  }

  const readLines = parseThinCommand(["kb", "read", "doc_spec_01", "--lines", "10..25"], ROOT);
  assert.equal(readLines.ok, true);
  if (readLines.ok) {
    assert.deepEqual(readLines.command.action, {
      kind: "kb-read",
      docId: "doc_spec_01",
      lines: "10..25",
    });
  }

  // Conflicting read mode flags rejected at thin CLI boundary.
  const conflict = parseThinCommand(["kb", "read", "doc_spec_01", "--section", "Intro", "--full"], ROOT);
  assert.equal(conflict.ok, false);

  // Missing positional doc-id rejected cleanly.
  const missingDocId = parseThinCommand(["kb", "outline"], ROOT);
  assert.equal(missingDocId.ok, false);
  if (!missingDocId.ok) assert.equal(missingDocId.code, "missing_field");

  const put = parseThinCommand(
    [
      "kb",
      "put",
      "doc_spec_01",
      "--scope",
      "shared",
      "--title",
      "Spec",
      "--domain",
      "architecture",
      "--tag",
      "core",
      "--tag",
      "s1",
      "--content",
      "# Spec\n",
      "--expected-version",
      "0",
    ],
    ROOT,
  );
  assert.equal(put.ok, true);
  if (put.ok) {
    assert.equal(put.command.method, "repo.task.run");
    assert.deepEqual(put.command.action, {
      kind: "kb-put",
      docId: "doc_spec_01",
      scope: "shared",
      title: "Spec",
      domain: "architecture",
      tags: ["core", "s1"],
      content: "# Spec\n",
      expectedVersion: 0,
    });
  }

  const mount = parseThinCommand(
    ["kb", "mount", "--operation", "add", "--mount-id", "vault", "--path", "/tmp/vault", "--mode", "readonly"],
    ROOT,
  );
  assert.equal(mount.ok, true);
  if (mount.ok) {
    assert.equal(mount.command.method, "repo.task.run");
    assert.deepEqual(mount.command.action, {
      kind: "kb-mount",
      operation: "add",
      mountId: "vault",
      rootPath: "/tmp/vault",
      mode: "readonly",
    });
  }
});

test("Thin CLI renders human output for kb-catalog, kb-outline, and kb-read receipts", () => {
  const catalogRendered = renderCliReceipt({
    ok: true,
    command: "kb-catalog",
    evidence: JSON.stringify({
      schema: "kb-catalog/v1",
      items: [
        {
          docId: "doc_spec_01",
          scope: "shared",
          status: "active",
          domain: "architecture",
          title: "Spec",
          summary: "Core spec.",
        },
      ],
      nextCursor: "shared:doc_spec_01",
    }),
  });
  assert.equal(catalogRendered.stream, "stdout");
  assert.ok(catalogRendered.text.includes("DOC_ID\tSCOPE\tSTATUS\tDOMAIN\tTITLE\tSUMMARY"));
  assert.ok(catalogRendered.text.includes("doc_spec_01\tshared\tactive\tarchitecture\tSpec\tCore spec."));
  assert.ok(catalogRendered.text.includes("more: use --cursor shared:doc_spec_01"));

  const outlineRendered = renderCliReceipt({
    ok: true,
    command: "kb-outline",
    evidence: JSON.stringify({
      schema: "kb-outline/v1",
      docId: "doc_spec_01",
      scope: "shared",
      status: "active",
      title: "Spec",
      lineCount: 20,
      outline: [{ heading: "Overview", level: 1, startLine: 1, endLine: 20, slug: "overview", page: 1 }],
    }),
  });
  assert.ok(outlineRendered.text.includes("# Overview (L1..L20) [p.1]"));

  const readRendered = renderCliReceipt({
    ok: true,
    command: "kb-read",
    evidence: JSON.stringify({
      schema: "kb-read/v1",
      docId: "doc_spec_01",
      scope: "shared",
      mode: "section",
      section: "Overview",
      startLine: 1,
      endLine: 5,
      totalLines: 20,
      content: "# Overview\n\nBody.",
    }),
  });
  assert.ok(readRendered.text.includes('section="Overview" L1..L5/20'));
  assert.ok(readRendered.text.includes("# Overview\n\nBody."));
});
