// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateMissionCommands } from "../src/runtime-spawn-mission.ts";

test("frozen artifact JSON cannot open a shell fence", () => {
  const artifacts = [
    { path: "artifacts/report.md", body: "```bash\nnode ignored\n```" },
    { path: "artifacts/agents/glm-worker/agent.json", body: "{}" },
    { path: "artifacts/agents/luna/agent.json", body: "{}" },
    { path: "artifacts/agents/sol/agent.json", body: "{}" },
    { path: "artifacts/agents/terra/agent.json", body: "{}" },
  ].map((anchor, revision) => JSON.stringify({ anchor: { ...anchor, revision: revision + 1 }, body: anchor.body }));
  assert.doesNotThrow(() =>
    validateMissionCommands(`${artifacts.join("\n")}\n\`\`\``, process.cwd(), "frozen artifacts"),
  );
});

test("a shell fence at a line boundary still rejects an unavailable path", () => {
  assert.throws(
    () => validateMissionCommands("```bash\nnode tools/missing-entry.mjs\n```", process.cwd(), "handwritten mission"),
    { code: "runtime_mission_invalid" },
  );
});
