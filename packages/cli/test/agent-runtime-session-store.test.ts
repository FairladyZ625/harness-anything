// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileRuntimeSessionStore } from "../src/daemon/agent-runtime-session-store.ts";

test("runtime session store persists safe witness records and fails closed on malformed state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-runtime-store-"));
  const store = createFileRuntimeSessionStore(root);
  await store.save([]);
  const body = await readFile(path.join(root, ".harness/generated/agent-runtime-sessions.json"), "utf8");
  assert.deepEqual(JSON.parse(body), { schema: "agent-runtime-session-store/v1", sessions: [] });

  await writeFile(path.join(root, ".harness/generated/agent-runtime-sessions.json"), '{"schema":"wrong","sessions":[]}\n');
  await assert.rejects(store.load(), /invalid runtime session store schema/u);
});
