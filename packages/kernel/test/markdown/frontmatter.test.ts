import assert from "node:assert/strict";
import test from "node:test";
import { readFrontmatter, readNestedScalar, readScalar } from "../../src/markdown/frontmatter.ts";

test("reads frontmatter block and scalar values", () => {
  const frontmatter = readFrontmatter("---\ntitle: Demo\nlifecycle:\n  status: active\n---\n# Demo\n");
  assert.equal(frontmatter, "title: Demo\nlifecycle:\n  status: active");
  assert.equal(readScalar(frontmatter ?? "", "title"), "Demo");
  assert.equal(readScalar(frontmatter ?? "", "  status"), "active");
});

test("reads frontmatter with Windows CRLF line endings", () => {
  const frontmatter = readFrontmatter("---\r\ntitle: Demo\r\nlifecycle:\r\n  status: active\r\n---\r\n# Demo\r\n");
  assert.equal(frontmatter, "title: Demo\r\nlifecycle:\r\n  status: active");
  assert.equal(readScalar(frontmatter ?? "", "title"), "Demo");
  assert.equal(readScalar(frontmatter ?? "", "  status"), "active");
});

test("missing optional scalar returns empty string", () => {
  assert.equal(readScalar("title: Demo", "missing"), "");
});

test("missing required scalar fails closed", () => {
  assert.throws(
    () => readScalar("title: Demo", "missing", { required: true }),
    /frontmatter missing missing/
  );
});

test("reads nested scalar blocks", () => {
  assert.equal(readNestedScalar("  name: Ada\n  email: ada@example.test\n", "email"), "ada@example.test");
});
