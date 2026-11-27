// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  KB_DOCUMENT_BUNDLE_SCHEMA,
  headingSlug,
  kbCatalogCardFromBundle,
  parseKbMarkdownFrontmatter,
  parseLineRangeSpec,
  parseMarkdownOutline,
  readKbViewContent,
  validateKbDocumentBundleV1,
} from "../src/domain/kb-document-bundle.ts";
import {
  KB_DOCUMENT_EVENT_SCHEMA,
  compileKbDocumentUpserted,
  kbDocumentEventContentClaims,
  reduceKbDocumentEvent,
  validateCurrentKbDocumentEvent,
} from "../src/domain/kb-document-event.ts";
import { parseCanonicalEvent, serializeCanonicalEvent } from "../src/domain/doc-sync.contract.ts";

const MULTI_LEVEL_DOC = [
  "---",
  'title: "Constitutional Library Spec"',
  "docId: doc_spec_01",
  "domain: architecture",
  "tags: [kb, charter]",
  "aliases:",
  "  - kb-spec",
  "  - library-charter",
  "status: active",
  "relations:",
  "  - references:doc_intro",
  "---",
  "<!-- page:1 -->",
  "# 1. Architecture Overview",
  "",
  "This library stores Document Bundles in dual scopes.",
  "",
  "```markdown",
  "# Not A Real Heading Inside Code Fence",
  "## Also Ignored",
  "```",
  "",
  "## 1.1 Local-Private Scope",
  "",
  "Host-local storage never emits canonical events.",
  "",
  "### 1.1.1 Mount Security",
  "",
  "External mounts defend against symlink escapes and parent traversal.",
  "",
  "<!-- page:2 -->",
  "## 1.2 Center-Shared Scope",
  "",
  "Shared writes pass RBAC and single-writer CAS.",
  "",
  "# 2. Borrowing Protocol",
  "",
  "Catalog -> Outline -> Complete Section Read without fixed chunking.",
].join("\n");

test("deterministic Markdown outline parser handles multi-level headings, fences, CRLF, and page anchors", () => {
  const crlfDoc = MULTI_LEVEL_DOC.replace(/\n/gu, "\r\n");
  const outline = parseMarkdownOutline(crlfDoc);

  assert.deepEqual(
    outline.map((h) => ({
      heading: h.heading,
      level: h.level,
      startLine: h.startLine,
      endLine: h.endLine,
      page: h.page,
    })),
    [
      { heading: "1. Architecture Overview", level: 1, startLine: 14, endLine: 35, page: 1 },
      { heading: "1.1 Local-Private Scope", level: 2, startLine: 23, endLine: 31, page: 1 },
      { heading: "1.1.1 Mount Security", level: 3, startLine: 27, endLine: 31, page: 1 },
      { heading: "1.2 Center-Shared Scope", level: 2, startLine: 32, endLine: 35, page: 2 },
      { heading: "2. Borrowing Protocol", level: 1, startLine: 36, endLine: 38, page: 2 },
    ],
  );
  assert.equal(headingSlug("1.1 Local-Private Scope"), "1-1-local-private-scope");
});

test("readKbViewContent returns complete chapters without fixed chunking, plus exact line ranges and full view", () => {
  // Large chapter (>5000 chars) must be returned intact, strictly zero 500-token chunking.
  const longParagraph = "Sentence explaining constitutional architecture invariants. ".repeat(100);
  const largeDoc = [
    "# Chapter One",
    "",
    "Intro line.",
    "",
    "## Deep Dive",
    "",
    longParagraph,
    "",
    "### Sub-detail",
    "",
    "Final sub-detail paragraph.",
    "",
    "# Chapter Two",
    "",
    "Second chapter body.",
  ].join("\n");

  const section = readKbViewContent(largeDoc, { section: "Chapter One" });
  assert.equal(section.ok, true);
  if (section.ok) {
    assert.equal(section.mode, "section");
    assert.equal(section.section, "Chapter One");
    assert.equal(section.startLine, 1);
    assert.equal(section.endLine, 12);
    assert.ok(section.content.includes(longParagraph), "long chapter must not be truncated or chunked");
    assert.ok(section.content.includes("### Sub-detail"), "complete chapter includes nested subsections");
    assert.ok(!section.content.includes("# Chapter Two"), "sibling chapter is excluded");
  }

  const bySlug = readKbViewContent(MULTI_LEVEL_DOC, { section: "1-2-center-shared-scope" });
  assert.equal(bySlug.ok, true);
  if (bySlug.ok) {
    assert.equal(bySlug.section, "1.2 Center-Shared Scope");
    assert.ok(bySlug.content.includes("single-writer CAS"));
  }

  const lines = readKbViewContent(MULTI_LEVEL_DOC, { lines: parseLineRangeSpec("23..29")! });
  assert.equal(lines.ok, true);
  if (lines.ok) {
    assert.equal(lines.mode, "lines");
    assert.equal(lines.startLine, 23);
    assert.equal(lines.endLine, 29);
    assert.ok(lines.content.startsWith("## 1.1 Local-Private Scope"));
    assert.ok(lines.content.includes("External mounts defend"));
  }

  const full = readKbViewContent(MULTI_LEVEL_DOC, { full: true });
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(full.mode, "full");
    assert.equal(full.startLine, 1);
    assert.equal(full.endLine, full.totalLines);
  }

  const missing = readKbViewContent(MULTI_LEVEL_DOC, { section: "Nonexistent Heading" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "kb_section_not_found");

  const ambiguous = readKbViewContent(MULTI_LEVEL_DOC, { section: "1." });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, "kb_section_ambiguous");

  const conflict = readKbViewContent(MULTI_LEVEL_DOC, { section: "1.1", full: true });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "invalid_field");
});

test("frontmatter parser, canonical event compilation, content claims, and bundle validation work end-to-end", () => {
  const fm = parseKbMarkdownFrontmatter(MULTI_LEVEL_DOC);
  assert.equal(fm.title, "Constitutional Library Spec");
  assert.equal(fm.docId, "doc_spec_01");
  assert.equal(fm.domain, "architecture");
  assert.deepEqual(fm.tags, ["kb", "charter"]);
  assert.deepEqual(fm.aliases, ["kb-spec", "library-charter"]);
  assert.equal(fm.status, "active");
  assert.deepEqual(fm.relations, [{ type: "references", target: "doc_intro" }]);

  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const compiled = compileKbDocumentUpserted({
    eventId: "event-kb-1",
    opId: "op_kb_1",
    workspaceRevision: 1,
    actor: { principal: { personId: "person_alice" }, executor: null },
    source: "local",
    occurredAt: "2026-11-27T00:00:00.000Z",
    docId: "doc_spec_01",
    documentRevision: 1,
    manifest: {
      title: fm.title!,
      aliases: fm.aliases,
      summary: "A ".repeat(200).trim(),
      domain: fm.domain!,
      tags: fm.tags,
      status: "active",
      relations: fm.relations,
    },
    viewMarkdown: MULTI_LEVEL_DOC,
    sourceFilename: "source.pdf",
    sourceMediaType: "application/pdf",
    sourceBytes: pdfBytes,
    assets: [{ path: "assets/page-1.png", mediaType: "image/png", body: pngBytes, page: 1 }],
  });

  assert.equal(compiled.event.schema, KB_DOCUMENT_EVENT_SCHEMA);
  assert.deepEqual(validateCurrentKbDocumentEvent(compiled.event), []);
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(compiled.event)), compiled.event);
  assert.equal(compiled.blobs.length, 3);
  assert.equal(kbDocumentEventContentClaims(compiled.event).length, 3);

  const record = reduceKbDocumentEvent(null, compiled.event);
  assert.equal(record.schema, KB_DOCUMENT_BUNDLE_SCHEMA);
  assert.equal(record.scope, "shared");
  assert.equal(record.revision, 1);
  assert.equal(record.manifest.outline.length, 5);
  assert.deepEqual(
    validateKbDocumentBundleV1({
      schema: record.schema,
      docId: record.docId,
      scope: record.scope,
      revision: record.revision,
      manifest: record.manifest,
      source: record.source,
      view: record.view,
      assets: record.assets,
      updatedAt: record.updatedAt,
    }),
    [],
  );

  const card = kbCatalogCardFromBundle(record, 40);
  assert.equal(card.summaryTruncated, true);
  assert.ok(card.summary.length <= 40);
  assert.equal(card.headingCount, 5);
  assert.equal(card.sourceMediaType, "application/pdf");

  // Negative validation checks
  assert.ok(
    validateKbDocumentBundleV1({
      schema: KB_DOCUMENT_BUNDLE_SCHEMA,
      docId: "../escape",
      scope: "local",
      revision: 1,
      manifest: record.manifest,
      source: record.source,
      view: record.view,
      assets: [{ path: "assets/../evil.png", mediaType: "image/png", sha256: "a".repeat(64), byteLength: 1 }],
      updatedAt: record.updatedAt,
    }).length >= 2,
  );
});
