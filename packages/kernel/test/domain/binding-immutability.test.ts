import assert from "node:assert/strict";
import test from "node:test";
import {
  type LifecycleBinding,
  validateLifecycleBindingInvariant
} from "../../src/domain/lifecycle-binding.ts";

const baseBinding = {
  bindingSchema: "lifecycle-binding/v1",
  engine: "local",
  status: "active",
  ref: null,
  titleSnapshot: null,
  url: null,
  bindingCreatedAt: "2026-06-11T00:00:00.000Z",
  bindingFingerprint: "sha256:0123456789abcdef"
} as const satisfies LifecycleBinding;

test("binding invariant allows mutable display fields", () => {
  const next = {
    ...baseBinding,
    status: "blocked",
    titleSnapshot: "Updated display title",
    url: "https://example.invalid/task"
  } as const satisfies LifecycleBinding;

  assert.deepEqual(validateLifecycleBindingInvariant("task-1", baseBinding, next), { ok: true });
});

test("binding invariant rejects identity field changes", () => {
  const cases = [
    { field: "engine", next: { ...baseBinding, engine: "github" } },
    { field: "ref", next: { ...baseBinding, ref: "FAI-37" } },
    { field: "bindingCreatedAt", next: { ...baseBinding, bindingCreatedAt: "2026-06-12T00:00:00.000Z" } },
    { field: "bindingFingerprint", next: { ...baseBinding, bindingFingerprint: "sha256:changed" } }
  ] as const;

  for (const entry of cases) {
    const result = validateLifecycleBindingInvariant("task-1", baseBinding, entry.next);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error._tag, "BindingInvariantViolation");
      assert.equal(result.error.field, entry.field);
    }
  }
});
