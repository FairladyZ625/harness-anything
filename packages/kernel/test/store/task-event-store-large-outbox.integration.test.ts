// harness-test-tier: integration
import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { prepareCommit } from "../../src/store/task-event-store-git-refs.ts";
import { git, initRepo } from "./task-event-store.fixtures.ts";

test(
  "Git outbox publishes a greater-than-600MB batch without constructing one JavaScript payload",
  { timeout: 900_000 },
  () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "harness-large-outbox-"));
    try {
      initRepo(rootDir);
      writeFileSync(path.join(rootDir, "caller-index.txt"), "index before publication\n");
      git(rootDir, "add", "caller-index.txt");
      const beforeIndex = git(rootDir, "ls-files", "--stage"),
        parent = git(rootDir, "rev-parse", "HEAD"),
        bytesPerBlob = 61 * 1024 * 1024,
        files = Array.from({ length: 10 }, (_value, index) => ({
          mode: "100644" as const,
          target: `harness/large/blob-${index}.bin`,
          body: `${String.fromCharCode(65 + index).repeat(bytesPerBlob - 1)}\n`,
        }));
      const aggregateBytes = files.reduce((total, file) => total + Buffer.byteLength(file.body), 0);
      assert.ok(aggregateBytes > 600 * 1024 * 1024);
      assert.ok(aggregateBytes > bufferConstants.MAX_STRING_LENGTH);
      const commit = prepareCommit(
        rootDir,
        "refs/ha/tmp/large-outbox",
        parent,
        files,
        "large-outbox",
        "2026-09-06T00:00:00.000Z",
      );
      assert.match(commit, /^[0-9a-f]{40}$/u);
      for (const file of files) {
        const readback = localGitObjectRefStore.readPath(rootDir, commit, file.target);
        assert.ok(readback);
        assert.equal(readback.byteLength, Buffer.byteLength(file.body));
        assert.equal(
          createHash("sha256").update(readback).digest("hex"),
          createHash("sha256").update(file.body).digest("hex"),
        );
      }
      assert.equal(git(rootDir, "ls-files", "--stage"), beforeIndex);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);
