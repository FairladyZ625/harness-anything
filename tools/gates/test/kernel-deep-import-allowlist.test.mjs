// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import eslintConfig from "../../../eslint.config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const daemonFilesPattern = "packages/daemon/src/**/*.{ts,tsx,js,mjs}";
const restrictedKernelPattern = "**/kernel/src/**/*";
const publicBarrelException = "!**/kernel/src/index.ts";
const domainParentException = "!**/kernel/src/domain";
const contractVersionException = "!**/kernel/src/domain/contract-version.ts";

function daemonKernelDeepImportGroup() {
  const daemonOverrides = eslintConfig.filter((entry) => entry.files?.includes(daemonFilesPattern));
  assert.equal(daemonOverrides.length, 1, "daemon must have exactly one deep-import override");
  const patterns = daemonOverrides[0].rules?.["no-restricted-imports"]?.[1]?.patterns;
  assert.ok(Array.isArray(patterns), "daemon override must configure no-restricted-imports patterns");
  const kernelPatterns = patterns.filter((entry) => entry.group?.includes(restrictedKernelPattern));
  assert.equal(kernelPatterns.length, 1, "daemon override must have exactly one kernel deep-import group");
  return kernelPatterns[0].group;
}

test("daemon kernel deep-import allowlist contains only the effect-free contract version module", () => {
  const group = daemonKernelDeepImportGroup();

  // `no-restricted-imports` uses gitignore semantics: the parent directory must be
  // unignored before its child can be unignored. Lock the complete group so that
  // this structural companion cannot silently become a broader allowlist.
  assert.deepEqual(group, [
    restrictedKernelPattern,
    publicBarrelException,
    domainParentException,
    contractVersionException,
  ]);
  const daemonDeepImportAllowlist = group
    .filter((pattern) => pattern.startsWith("!") && ![publicBarrelException, domainParentException].includes(pattern))
    .map((pattern) => pattern.slice(1));
  assert.deepEqual(daemonDeepImportAllowlist, ["**/kernel/src/domain/contract-version.ts"]);
});

test("the daemon deep-import exception targets an import-free kernel module", async () => {
  const source = await readFile(path.join(repoRoot, "packages/kernel/src/domain/contract-version.ts"), "utf8");
  assert.doesNotMatch(source, /(?:^\s*import\s|(?:\bimport|\brequire)\s*\()/mu);
});

test("ESLint allows contract-version but rejects another daemon kernel deep import", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [allowed] = await eslint.lintText(
    'import { contractVersion } from "../../../kernel/src/domain/contract-version.ts";\nvoid contractVersion;\n',
    { filePath: "packages/daemon/src/kernel-contract-version-probe.ts" },
  );
  assert.deepEqual(
    allowed.messages.filter(({ ruleId }) => ruleId === "no-restricted-imports"),
    [],
  );

  const [rejected] = await eslint.lintText('import "../../../kernel/src/domain/index.ts";\n', {
    filePath: "packages/daemon/src/kernel-domain-index-probe.ts",
  });
  const restrictedMessages = rejected.messages.filter(({ ruleId }) => ruleId === "no-restricted-imports");
  assert.equal(restrictedMessages.length, 1);
  assert.match(restrictedMessages[0].message, /public barrel instead of deep src paths/u);
});
