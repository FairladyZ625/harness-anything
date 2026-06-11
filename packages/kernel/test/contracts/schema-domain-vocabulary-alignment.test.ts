import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import {
  domainStatuses
} from "../../src/domain/lifecycle-status.ts";
import {
  packageDispositions
} from "../../src/domain/package-disposition.ts";
import {
  DomainStatusSchema,
  TaskFrontmatterSchema
} from "../../src/schemas/registry.ts";

test("domain status constants are accepted by the schema registry", () => {
  for (const status of domainStatuses) {
    assert.equal(Schema.decodeUnknownSync(DomainStatusSchema)(status), status);
  }
});

test("task frontmatter schema accepts every domain package disposition", () => {
  for (const disposition of packageDispositions) {
    const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)({
      schema: "task-package/v2",
      task_id: "task-1",
      title: "Task",
      lifecycle: {
        bindingSchema: "lifecycle-binding/v1",
        engine: "local",
        status: "planned",
        ref: null,
        titleSnapshot: null,
        url: null,
        bindingCreatedAt: "2026-06-11T00:00:00.000Z",
        bindingFingerprint: "sha256:0123456789abcdef"
      },
      packageDisposition: disposition,
      vertical: "software/coding",
      preset: "standard-task"
    });

    assert.equal(decoded.packageDisposition, disposition);
  }
});
