// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installPresetPackage } from "../src/index.ts";
import { createPresetProcessService, waitFor, write } from "./preset-process-service.fixtures.ts";

test("an inherited entrypoint stages its declaring package and detects post-admission changes", async () => {
  const fixture = inheritedScriptPackage(),
    service = createPresetProcessService({
      rootDir: fixture.rootDir,
      userRoot: fixture.userRoot,
      timeoutMs: 1_000,
      publish: async () => {
        throw new Error("unexpected produce");
      },
    });
  try {
    const started = await service.start({
      presetId: "leaf-canary",
      entrypoint: "check",
      inputs: { title: "Inherited" },
      idempotencyKey: "inherit-ok",
    });
    assert.equal(started.phase, "admitted");
    const applied = await waitFor(
      "inherited preset run to reach a terminal outcome",
      () => service.status(started.runId),
      ({ outcome }) => outcome === "applied" || outcome === "failed",
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.deepEqual(applied.phases, ["admitted", "spawned", "running", "publishing", "applied"]);
    const admitted = await service.start({
      presetId: "leaf-canary",
      entrypoint: "check",
      inputs: { title: "Tamper" },
      idempotencyKey: "inherit-tamper",
    });
    assert.equal(admitted.phase, "admitted");
    write(path.join(fixture.parentObject, "scripts/check.mjs"), "process.exit(0);");
    const failed = await waitFor(
      "changed preset package rejection",
      () => service.status(admitted.runId),
      ({ outcome }) => outcome === "failed",
    );
    assert.equal(failed.code, "package_changed");
    assert.deepEqual(failed.phases, ["admitted", "failed"]);
  } finally {
    await service.close();
    fixture.cleanup();
  }
});

function inheritedScriptPackage() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-inherited-")),
    userRoot = path.join(rootDir, ".harness/presets"),
    source = path.join(rootDir, "source"),
    manifest = (id: string, extra: Record<string, unknown>) => ({
      schema: "preset-manifest/v3",
      id,
      title: id,
      vertical: "software/coding",
      version: "3.0.0",
      kind: "process-action",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [],
      profiles: [
        {
          id: "baseline",
          title: "Baseline",
          completionGates: [],
          templateSelections: [],
        },
      ],
      defaultProfile: "baseline",
      ...extra,
    });
  const parent = path.join(source, "base-canary"),
    leaf = path.join(source, "leaf-canary");
  write(
    path.join(parent, "preset.json"),
    JSON.stringify(
      manifest("base-canary", {
        entrypoints: {
          check: {
            type: "script",
            intent: "Inherited check",
            inputs: [{ name: "title", type: "string", required: true }],
            requires: [],
            produces: [],
            sideEffects: [],
            command: "scripts/check.mjs",
          },
        },
      }),
    ),
  );
  write(
    path.join(parent, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Base\nwhenToUse: Run inherited scripts.\n---\n# Base\n",
  );
  write(
    path.join(parent, "scripts/check.mjs"),
    'console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));',
  );
  write(path.join(leaf, "preset.json"), JSON.stringify(manifest("leaf-canary", { extends: "base-canary" })));
  write(
    path.join(leaf, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Leaf\nwhenToUse: Inherit the base.\n---\n# Leaf\n",
  );
  const installed = installPresetPackage({ source: parent, userRoot });
  installPresetPackage({ source: leaf, userRoot });
  return {
    rootDir,
    userRoot,
    parentObject: path.join(userRoot, "preset-objects", installed.digest),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}
