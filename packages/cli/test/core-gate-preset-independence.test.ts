// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const coreCommandsRoot = path.resolve("packages/cli/src/commands/core");
const presetIndexPath = path.resolve(
  "packages/cli/src/commands/extensions/assets/software-coding/presets/index.json"
);

test("core gate implementations do not compare bundled preset ids", () => {
  const presetIds = (JSON.parse(readFileSync(presetIndexPath, "utf8")) as {
    readonly presets: ReadonlyArray<string>;
  }).presets;
  const gateFiles = readdirSync(coreCommandsRoot)
    .filter((file) => file.includes("gate") && file.endsWith(".ts"))
    .sort();

  assert.notEqual(gateFiles.length, 0);
  for (const file of gateFiles) {
    const source = readFileSync(path.join(coreCommandsRoot, file), "utf8");
    for (const presetId of presetIds) {
      assert.equal(
        source.includes(`"${presetId}"`) || source.includes(`'${presetId}'`),
        false,
        `${file} must not couple a core gate to preset id ${presetId}`
      );
    }
  }
});

test("the lineage gate reads task lineage attributes, not preset metadata", () => {
  const source = readFileSync(path.join(coreCommandsRoot, "task-lineage-gate.ts"), "utf8");
  assert.doesNotMatch(source, /\bpreset\b/iu);
});
