// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkLocaleContent } from "./check-locale-content.mjs";

test("locale gate accepts the locale-neutral thin CLI", () => {
  assert.deepEqual(checkLocaleContent({ legacyRoot: path.join(tmpdir(), "missing-locale-templates"), commandSource: `usage: "ha task show <id>"` }), { ok: true, failures: [] });
});
test("locale gate rejects restored locale assets and locale flags", () => { const root = mkdtempSync(path.join(tmpdir(), "locale-templates-"));
  try { writeFileSync(path.join(root, "zh-CN.md"), "legacy"); const result = checkLocaleContent({ legacyRoot: root, commandSource: `usage: "ha task show <id> --locale <name>"` });
    assert.equal(result.ok, false); assert.match(result.failures.join("\n"), /must not return/u); assert.match(result.failures.join("\n"), /not a supported thin CLI contract/u);
  } finally { rmSync(root, { recursive: true, force: true }); } });
