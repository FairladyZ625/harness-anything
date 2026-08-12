// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  findPortablePathCollisions,
  normalizeRelativeDocumentPath
} from "../../src/layout/index.ts";

test("portable document paths normalize to POSIX relative paths", () => {
  assert.equal(normalizeRelativeDocumentPath("notes/./progress.md"), "notes/progress.md");
  assert.equal(normalizeRelativeDocumentPath("notes//progress.md"), "notes/progress.md");
});

test("portable document paths reject traversal, native absolute paths, and Windows separators", () => {
  for (const candidate of [
    "",
    ".",
    "..",
    "../outside.md",
    "/tmp/outside.md",
    "C:/Users/name/secret.md",
    "C:\\Users\\name\\secret.md",
    "\\\\server\\share\\secret.md",
    "notes\\progress.md",
    "notes/\0secret.md"
  ]) {
    assert.throws(() => normalizeRelativeDocumentPath(candidate), Error, candidate);
  }
});

test("portable document paths reject Windows reserved and non-portable segment names", () => {
  for (const candidate of [
    "CON",
    "con.md",
    "notes/PRN.txt",
    "notes/AUX",
    "notes/NUL",
    "notes/COM1",
    "notes/LPT9.md",
    "notes/trailing-space ",
    "notes/trailing-dot.",
    "notes/colon:name.md",
    "notes/star*.md",
    "notes/question?.md",
    "notes/pipe|name.md"
  ]) {
    assert.throws(() => normalizeRelativeDocumentPath(candidate), Error, candidate);
  }
});

test("portable document path collisions are detected case-insensitively", () => {
  assert.deepEqual(findPortablePathCollisions([
    "Task.md",
    "task.md",
    "notes/Progress.md",
    "notes/progress.md",
    "notes/review.md"
  ]), [
    {
      canonicalPath: "task.md",
      paths: ["Task.md", "task.md"]
    },
    {
      canonicalPath: "notes/progress.md",
      paths: ["notes/Progress.md", "notes/progress.md"]
    }
  ]);
});

test("portable document path collisions retain raw NFC/NFD spellings", () => {
  assert.deepEqual(findPortablePathCollisions(["notes/café.md", "notes/cafe\u0301.md"]), [{
    canonicalPath: "notes/café.md", paths: ["notes/cafe\u0301.md", "notes/café.md"]
  }]);
});
