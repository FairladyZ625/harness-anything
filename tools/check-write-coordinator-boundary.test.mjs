// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findW3WriteAuthorityViolations } from "./check-write-coordinator-boundary.mjs";

test("W3 write authority accepts RepoCell as the sole production event-store composition root", () => withFixture((root) => {
  assert.deepEqual(findW3WriteAuthorityViolations(root), []);
}));

test("W3 write authority rejects restoration of a journal coordinator", () => withFixture((root) => {
  write(root, "packages/kernel/src/store/write-journal-coordinator.ts", "export const legacy = true;\n");
  assert.match(findW3WriteAuthorityViolations(root).join("\n"), /W3-retired production write path must not exist/u);
}));

test("W3 write authority rejects a second event-store composition root", () => withFixture((root) => {
  write(root, "packages/application/src/fallback.ts", "const fallback = makeTaskEventStore({ rootDir });\n");
  assert.match(findW3WriteAuthorityViolations(root).join("\n"), /production consumers must be exactly/u);
}));

function withFixture(run) { const root = mkdtempSync(path.join(tmpdir(), "w3-write-authority-")); try {
  write(root, "packages/daemon/src/repo-cell.ts", `import { makeTaskEventStore } from "../../kernel/src/index.ts";\nimport { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";\nconst store = makeTaskEventStore({ rootDir });\nconst service = makeTaskLifecycleService({ eventStore: store, projection });\nlet tail = Promise.resolve();\ntail = tail.then(() => service.execute(command));\n`);
  write(root, "packages/kernel/src/store/task-event-store.ts", `export function makeTaskEventStore() {}\nprepareLocalEventCommit();\nfinalizeLocalEventCommit();\n`);
  write(root, "packages/application/src/task-lifecycle-service.ts", `export function makeTaskLifecycleService(options) { options.eventStore.append(event); }\n`);
  write(root, "packages/cli/src/index.ts", `import { runCommandThroughDaemon } from "./daemon/client.ts";\n`);
  run(root);
} finally { rmSync(root, { recursive: true, force: true }); } }
function write(root, relative, body) { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
