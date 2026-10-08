// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installPresetPackage } from "../src/index.ts";
import { createPresetProcessService, waitFor, write } from "./preset-process-service.fixtures.ts";

for (const scenario of [
  "applied",
  "child-exit",
  "timeout",
  "close",
  "replay",
  "admission-rejected",
  "package-changed",
]) {
  test(`preset releases admission resources once for ${scenario}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-settlement-")),
      userRoot = path.join(rootDir, ".harness/presets"),
      source = path.join(rootDir, "source"),
      script = ["timeout", "close"].includes(scenario)
        ? "setInterval(() => {}, 100);"
        : scenario === "child-exit"
          ? "process.exit(1);"
          : 'console.log(JSON.stringify({schema:"preset-script-result/v1",produces:[]}));';
    write(
      path.join(source, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Settlement\nwhenToUse: Test settlement\n---\n# Settlement\n",
    );
    write(path.join(source, "scripts/check.mjs"), script);
    write(
      path.join(source, "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "user-settlement",
        title: "Settlement",
        vertical: "software/coding",
        version: "3.0.0",
        kind: "process-action",
        outputShape: "repository-diff",
        kernelVersionRange: { min: "1.0.0" },
        capabilityImports: [],
        entrypoints: {
          check: {
            type: "script",
            intent: "Settlement",
            inputs: [],
            requires: [],
            produces: [],
            sideEffects: [],
            command: "scripts/check.mjs",
          },
        },
        profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }],
        defaultProfile: "baseline",
      }),
    );
    const installed = installPresetPackage({ source, userRoot }),
      service = createPresetProcessService({ rootDir, userRoot, timeoutMs: scenario === "timeout" ? 100 : 5_000 });
    let released = 0,
      replayReleased = 0;
    try {
      const input = {
          presetId: "user-settlement",
          entrypoint: scenario === "admission-rejected" ? "absent" : "check",
          idempotencyKey: "once",
        },
        started = await service.start(input, {
          onSettled: () => {
            released += 1;
          },
          publish: async () => {
            throw new Error("unexpected produce");
          },
        });
      if (scenario === "admission-rejected") {
        assert.equal(started.outcome, "op_rejected");
      } else {
        assert.equal(started.phase, "admitted");
        assert.equal(released, 0, "start receipt does not release execution resources");
        if (scenario === "package-changed")
          write(path.join(userRoot, "preset-objects", installed.digest, "scripts/check.mjs"), "process.exit(0);");
        if (scenario === "replay") {
          const replay = await service.start(input, {
            onSettled: () => {
              replayReleased += 1;
            },
            publish: async () => {
              throw new Error("replay cannot publish");
            },
          });
          assert.equal(replay.runId, started.runId);
          assert.equal(replayReleased, 1, "replayed admission owns no execution");
          assert.equal(released, 0, "original execution remains live");
        }
        if (scenario === "close") {
          await waitFor(
            "child running",
            () => service.status(started.runId),
            ({ phase }) => phase === "running",
          );
          await service.close();
        }
        const final = await waitFor(
          "terminal witness",
          () => service.status(started.runId),
          ({ outcome }) => ["applied", "failed", "outcome_unknown"].includes(outcome),
        );
        assert.equal(
          final.outcome,
          ["applied", "replay"].includes(scenario) ? "applied" : scenario === "close" ? "outcome_unknown" : "failed",
        );
      }
      assert.equal(released, 1);
      await service.close();
      assert.equal(released, 1, "closing after settlement does not release twice");
    } finally {
      await service.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
