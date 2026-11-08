// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The computed delta is measured from the branch's merge-base alone (dec_BB2BCE9F995CD3A126E2918734
// CH3): reruns must not fetch or replay the pull request body for this gate. The advisory job now
// also serves the live-body dependency gate, so the guarantee is pinned on the gate command.
test("production-delta computes from the diff and reads no pull request body", () => {
  const manifest = JSON.parse(readFileSync(path.join(rootDir, "tools/gate-manifest.json"), "utf8"));
  const gate = manifest.gates.find((entry) => entry.id === "production-delta");
  assert.match(gate.command, /--base "\$\{PR_BASE_SHA:-origin\/main\}"/u);
  assert.doesNotMatch(gate.command, /--pr-body-file|--pr-body-env|gh pr view|GITHUB_EVENT_PATH/u);
});
