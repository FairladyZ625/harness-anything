// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Pins the react-hooks eslint contract introduced for packages/gui: rules-of-hooks
// must error (a hook after an early return is the A1 defect class), exhaustive-deps
// must stay at warn (36 pre-existing warnings at introduction), and both rules must
// apply only inside packages/gui.
const hookAfterEarlyReturn = [
  `import { useState } from "react";`,
  `export function ReactHooksRulesProbe(enabled: boolean) {`,
  `  if (!enabled) {`,
  `    return null;`,
  `  }`,
  `  const [value] = useState(0);`,
  `  return value;`,
  `}`,
].join("\n");

const missingDependencyEffect = [
  `import { useEffect } from "react";`,
  `export function ReactHooksRulesProbe({ id }: { id: string }) {`,
  `  useEffect(() => {`,
  `    void id;`,
  `  }, []);`,
  `  return null;`,
  `}`,
].join("\n");

async function lintProbe(source, filePath) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages;
}

test("rules-of-hooks errors on a hook called after an early return in GUI sources", async () => {
  const messages = await lintProbe(hookAfterEarlyReturn, "packages/gui/src/renderer/ReactHooksRulesProbe.tsx");
  const hits = messages.filter((message) => message.ruleId === "react-hooks/rules-of-hooks");
  assert.equal(hits.length, 1, JSON.stringify(messages));
  assert.equal(hits[0].severity, 2);
});

test("exhaustive-deps warns instead of errors on a missing effect dependency in GUI sources", async () => {
  const messages = await lintProbe(missingDependencyEffect, "packages/gui/src/renderer/ReactHooksRulesProbe.tsx");
  const hits = messages.filter((message) => message.ruleId === "react-hooks/exhaustive-deps");
  assert.equal(hits.length, 1, JSON.stringify(messages));
  assert.equal(hits[0].severity, 1);
});

test("react-hooks rules apply only inside packages/gui", async () => {
  const messages = await lintProbe(hookAfterEarlyReturn, "packages/kernel/src/ReactHooksRulesProbe.tsx");
  assert.equal(
    messages.filter((message) => message.ruleId?.startsWith("react-hooks/")).length,
    0,
    JSON.stringify(messages),
  );
});
