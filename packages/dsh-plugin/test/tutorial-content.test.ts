// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { TUTORIAL_LAYOUT, tutorialCopy } from "../src/tutorial-content.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const allText = (language: keyof typeof tutorialCopy): string => JSON.stringify(tutorialCopy[language]);

test("tutorial languages have the same section and item structure", () => {
  const shape = (language: keyof typeof tutorialCopy) =>
    tutorialCopy[language].sections.map((section) => [
      section.id,
      section.items.map((item) => [!!item.say, !!item.command, item.tag ?? null]),
    ]);
  assert.deepEqual(shape("en"), shape("zh"));
});

test("tutorial error codes are the codes the plugin actually reports", () => {
  // The panel shows plugin codes and the codes `ha gui` returns through the broker.
  const sources = read("../src/broker.ts") + read("../src/client.ts") + read("../../cli/src/cli/gui-launch.ts");
  for (const language of ["zh", "en"] as const) {
    const codes = [...allText(language).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
    assert.ok(codes.length >= 3, `${language}: expected error codes in the troubleshooting section`);
    for (const code of codes) {
      assert.ok(sources.includes(`"${code}"`), `${language}: ${code} is not reported by the plugin`);
    }
  }
});

test("tutorial presets are declared by the bundle patch", () => {
  const patch = read("../cordis.patch.yml");
  for (const preset of ["ha-ceo", "ha-worker"]) {
    assert.ok(patch.includes(`id: ${preset}\n`), `${preset} is not declared in cordis.patch.yml`);
  }
});

test("tutorial tabs place every section exactly once", () => {
  const placed = TUTORIAL_LAYOUT.flat()
    .map(([id]) => id)
    .sort();
  for (const language of ["zh", "en"] as const) {
    assert.deepEqual(placed, tutorialCopy[language].sections.map((section) => section.id).sort());
    assert.equal(tutorialCopy[language].tabs.length, TUTORIAL_LAYOUT.length);
  }
});

test("every skill the tutorial links to exists in the repository skills folder", () => {
  const source = readFileSync(new URL("../src/tutorial-content.ts", import.meta.url), "utf8");
  const linked = new Set([...source.matchAll(/skillUrl\("([^"]+)"\)/gu)].map((match) => match[1]!));
  assert.ok(linked.size > 0);
  for (const skill of linked) {
    assert.ok(
      existsSync(new URL(`../../../skills/${skill}/SKILL.md`, import.meta.url)),
      `tutorial links skills/${skill}/SKILL.md, which does not exist`,
    );
  }
});
