// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCanonicalPathBytes,
  createNamespaceAdmissionService,
  NamespaceAdmissionError,
  validatePortableManagedPath
} from "../../application/src/index.ts";

test("portable-ascii-v2 rejects reserved, non-ASCII, overlong, and Windows-budget paths", () => {
  for (const candidate of ["tasks/CON.md", "tasks/naïve.md", `tasks/${"a".repeat(113)}.md`, `${"a".repeat(181)}`]) {
    assert.throws(() => validatePortableManagedPath(candidate), NamespaceAdmissionError, candidate);
  }
  assert.throws(
    () => validatePortableManagedPath("tasks/ok.md", { windowsVisibleRootUnits: 60 }),
    (error: unknown) => error instanceof NamespaceAdmissionError && error.code === "WINDOWS_ROOT_TOO_LONG"
  );
  assert.equal(validatePortableManagedPath("tasks/task_01ABC/INDEX.md", { windowsVisibleRootUnits: 59 }).policy, "portable-ascii-v2");
  assert.deepEqual(["a", "A", "a-"].sort(compareCanonicalPathBytes), ["A", "a", "a-"]);
});

test("folded component trie rejects aliases and file ancestors while grandfathering exact legacy paths", () => {
  const legacy = `tasks/${"legacy-".repeat(30)}.md`;
  const admission = createNamespaceAdmissionService(["A/x.md", legacy]);

  assert.equal(admission.admitNewPath(legacy), undefined, "an exact legacy update is not a new-path admission");
  assert.throws(
    () => admission.admitNewPath("a/y.md"),
    (error: unknown) => error instanceof NamespaceAdmissionError && error.code === "CASE_COLLISION"
  );
  admission.admitNewPath("docs/file");
  assert.throws(
    () => admission.admitNewPath("docs/file/child.md"),
    (error: unknown) => error instanceof NamespaceAdmissionError && error.code === "FILE_ANCESTOR"
  );
});
