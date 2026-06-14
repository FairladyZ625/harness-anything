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
      readmeSuffix: "Read `.harness-private/coding-agent-harness/planning/task`.\n"
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
  const expectedDocs = [
    "m1-minimal-loop.md",
    "m2-coding-vertical.md",
    "m2-5-gui-distribution.md",
    "m2-5-runtime-release.md",
    "harness-agent-skill.md"
  ];

  writeFile(root, "README.md", [
    "# Harness Anything",
    "- [M1 minimal loop](./docs-release/m1-minimal-loop.md)",
    "- [M2 coding vertical](./docs-release/m2-coding-vertical.md)",
    "- [M2.5 product line map](./docs-release/m2-5-product-line.md)",
    "- [M2.5 GUI distribution and update](./docs-release/m2-5-gui-distribution.md)",
    "- [M2.5 runtime and release readiness](./docs-release/m2-5-runtime-release.md)",
    "- [Harness agent skill](./docs-release/harness-agent-skill.md)",
    "M2.5 GUI/daemon foundation is foundation-only.",
    "Private planning lives in `.harness-private/`.",
    "Do not add `.harness-private/` to public commits.",
    options.readmeSuffix ?? ""
  ].join("\n"));

  for (const doc of expectedDocs) {
    writeFile(root, `docs-release/${doc}`, "# Placeholder\n\nFuture or shipped status is explicit here.\n");
  }

  writeFile(root, "docs-release/m2-5-product-line.md", [
    "# M2.5 Product Line Map",
    "## Status taxonomy",
    "- Shipped: usable from this repository.",
    "- Foundation: contract exists, but end-user product capability is not shipped yet.",
    "- Planned: owned by a later milestone.",
    "## Current product line",
    "M2.5 GUI/daemon foundation",
    "M3-M7",
    "## Public documentation map",
    "- [M1 minimal loop](./m1-minimal-loop.md)",
    "- [M2 coding vertical](./m2-coding-vertical.md)",
    "- [M2.5 GUI distribution and update](./m2-5-gui-distribution.md)",
    "- [M2.5 runtime and release readiness](./m2-5-runtime-release.md)",
    "- [Harness agent skill](./harness-agent-skill.md)",
    options.docsSuffix ?? ""
  ].join("\n"));
}

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${body.trimEnd()}\n`, "utf8");
}
