import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-docs-release-map.mjs");

test("docs release map check accepts the expected public documentation map", async () => {
  await withFixtureRepo((root) => {
    writeValidDocsMap(root);

    const result = runDocsMapCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Docs release map check passed/u);
  });
});

test("docs release map check rejects README private planning subpaths", async () => {
  await withFixtureRepo((root) => {
    writeValidDocsMap(root, {
      readmeSuffix: "Read `.harness-private/coding-agent-harness/task`.\n"
    });

    const result = runDocsMapCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /browsable private harness subpath/u);
  });
});

test("docs release map check rejects shipped capability overclaim variants", async () => {
  const claims = [
    "Signed desktop installers are shipped.",
    "The auto-update capability is available.",
    "M4 external adapters are implemented.",
    "M3 task hierarchy is complete."
  ];

  for (const claim of claims) {
    await withFixtureRepo((root) => {
      writeValidDocsMap(root, { docsSuffix: claim });

      const result = runDocsMapCheck(root);

      assert.notEqual(result.status, 0, claim);
      assert.match(result.stderr, /may overclaim/u);
    });
  }
});

function runDocsMapCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8"
  });
}

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-docs-map-"));
  try {
    mkdirSync(path.join(root, "docs-release"), { recursive: true });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeValidDocsMap(root, options = {}) {
  writeFile(root, "README.md", [
    "# Harness Anything",
    "The accountability layer for AI agents.",
    "Private planning lives in `.harness-private/`.",
    "Do not add `.harness-private/` to public commits.",
    options.readmeSuffix ?? ""
  ].join("\n"));

  writeFile(root, "docs-release/release-posture.md", [
    "# Release Posture",
    "## Status taxonomy",
    "- Shipped: usable from this repository.",
    "- Foundation: contract exists, but end-user product capability is not shipped yet.",
    "- Planned: owned by a later milestone.",
    "## Product line status",
    "M2.5 GUI/daemon foundation",
    "M3-M7",
    options.docsSuffix ?? ""
  ].join("\n"));
}

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${body.trimEnd()}\n`, "utf8");
}
