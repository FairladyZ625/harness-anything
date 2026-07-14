// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import test from "node:test";
import { eslintLayerBoundaryMessages } from "./eslint-layer-boundaries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "tools/fixtures/eslint-layer-boundaries");

async function lintFixture(fixtureName, virtualFilePath) {
  const eslint = new ESLint({ cwd: repoRoot });
  const source = await readFile(path.join(fixtureRoot, fixtureName), "utf8");
  const [result] = await eslint.lintText(source, {
    filePath: path.join(repoRoot, virtualFilePath)
  });
  return result;
}

test("application triadic/projection consumer rejects a synthetic authored-document store import", async () => {
  const result = await lintFixture(
    "application-triadic-read-authored-document.ts",
    "packages/application/src/local-controller-service.ts"
  );

  assert.ok(
    result.messages.some((message) => message.message.includes(eslintLayerBoundaryMessages.applicationTriadicProjection)),
    "synthetic readAuthoredDocument import should fail the application projection boundary"
  );
});

test("application triadic/projection consumer rejects the ArtifactStore runtime tag", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(
    'import { ArtifactStore } from "../../kernel/src/index.ts";\nexport const storeTag = ArtifactStore;\n',
    { filePath: path.join(repoRoot, "packages/application/src/local-controller-service.ts") }
  );

  assert.ok(
    result.messages.some((message) => message.message.includes(eslintLayerBoundaryMessages.applicationTriadicProjection)),
    "ArtifactStore runtime tag import should fail the application projection boundary"
  );
});

test("application triadic/projection consumer still permits ArtifactStore type-only dependencies", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(
    'import type { ArtifactStore } from "../../kernel/src/index.ts";\nexport type Store = ArtifactStore;\n',
    { filePath: path.join(repoRoot, "packages/application/src/local-controller-service.ts") }
  );

  assert.equal(
    result.messages.some((message) => message.message.includes(eslintLayerBoundaryMessages.applicationTriadicProjection)),
    false
  );
});

test("renderer rejects a synthetic kernel store import", async () => {
  const result = await lintFixture(
    "renderer-kernel-store.ts",
    "packages/gui/src/renderer/kernel-store-boundary-fixture.ts"
  );

  assert.ok(
    result.messages.some((message) => message.message.includes(eslintLayerBoundaryMessages.rendererKernelStorage)),
    "synthetic renderer store import should fail the renderer storage boundary"
  );
});

test("current local controller remains green after fact reads moved to the triadic projection", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintFiles([
    path.join(repoRoot, "packages/application/src/local-controller-service.ts")
  ]);

  assert.equal(result.errorCount, 0, JSON.stringify(result.messages, null, 2));
});
