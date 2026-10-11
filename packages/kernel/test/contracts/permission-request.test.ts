// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  beginPermissionApproval,
  createPermissionRequest,
  PermissionRequestError,
  settlePermissionApproval,
} from "../../src/domain/permission-request.ts";

const resource = { kind: "entity", repoId: "repo", entityRef: "task/task-a" } as const;
test("approval is applying until the Keycloak write settles", () => {
  const request = createPermissionRequest({
    requestId: "req-1",
    requesterPersonId: "alice",
    resource,
    actions: ["task-start"],
    reason: "run the task",
  });
  const applying = beginPermissionApproval(request, 0, "bob");
  assert.equal(applying.status, "applying");
  assert.equal(settlePermissionApproval(applying, { ok: true }).request.status, "effective");
  const failed = settlePermissionApproval(applying, { ok: false, error: "keycloak unavailable" });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.request.error, "keycloak unavailable");
});

test("stale and self approvals are rejected before external writes", () => {
  const request = createPermissionRequest({
    requestId: "req-2",
    requesterPersonId: "alice",
    resource,
    actions: ["task-start"],
    reason: "run",
  });
  assert.throws(
    () => beginPermissionApproval(request, 1, "bob"),
    (error) => error instanceof PermissionRequestError && error.code === "version_conflict",
  );
  assert.throws(
    () => beginPermissionApproval(request, 0, "alice"),
    (error) => error instanceof PermissionRequestError && error.code === "self_approval",
  );
});
