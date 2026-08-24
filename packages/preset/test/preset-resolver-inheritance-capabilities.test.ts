// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createCanonicalPresetResolver,
  installPresetPackage,
  uninstallPresetPackage,
} from "../src/index.ts";
import { decodePresetPackageV3 } from "../src/preset-resolver.ts";

import {
  makeFixture,
  templateCatalog,
  write,
  writePackage,
} from "./preset-resolver.fixtures.ts";
test("an inherited entrypoint remains bound to the package that declared its script", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "script-parent", {
      kind: "process-action",
      entrypoints: {
        run: {
          type: "script",
          intent: "Run parent",
          inputs: [],
          requires: [],
          produces: [],
          sideEffects: [],
          command: "scripts/run.mjs",
        },
      },
    });
    write(
      path.join(fixture.bundledRoot, "script-parent/scripts/run.mjs"),
      "export {};\n",
    );
    writePackage(fixture.bundledRoot, "script-child", {
      extends: "script-parent",
    });
    const result = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "script-child",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "script-run",
      entrypoint: "run",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const parentDigest = decodePresetPackageV3(
        path.join(fixture.bundledRoot, "script-parent"),
      ).packageDigest;
      assert.match(
        result.snapshot.entrypoints.run!.commandSha256,
        /^[0-9a-f]{64}$/u,
      );
      assert.equal(result.package?.packageDigest, parentDigest);
      assert.notEqual(result.snapshot.provenance.packageSha256, parentDigest);
    }
  } finally {
    fixture.cleanup();
  }
});

test("resolver rejects a package outside the kernel version range", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "future", {
      kernelVersionRange: { min: "2.0.0" },
    });
    const result = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
      kernelVersion: "1.0.0",
    }).resolve({
      presetId: "future",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "incompatible_kernel");
  } finally {
    fixture.cleanup();
  }
});

test("resolver reports every missing required capability with catalog recovery fields", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "needs-provider", {
      capabilityImports: [
        {
          id: "policy:missing-b/v1",
          kind: "command",
          version: "1",
          required: true,
        },
        {
          id: "policy:missing-a/v1",
          kind: "command",
          version: "1",
          required: true,
        },
      ],
    });
    const resolver = createCanonicalPresetResolver({
        bundledRoot: fixture.bundledRoot,
        userRoot: fixture.userRoot,
        assetsRoot: fixture.assetsRoot,
      }),
      result = await resolver.resolve({
        presetId: "needs-provider",
        verticalId: "software/coding",
        locale: "en-US",
        purpose: "inspect",
      }),
      listed = (await resolver.list({ verticalId: "software/coding" })).find(
        ({ id }) => id === "needs-provider",
      );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "missing_provider");
    assert.deepEqual(listed?.missingProviderIds, [
      "policy:missing-a/v1",
      "policy:missing-b/v1",
    ]);
    assert.match(
      listed?.nextAction ?? "",
      /provides policy:missing-a\/v1, policy:missing-b\/v1.*ha preset list/iu,
    );
  } finally {
    fixture.cleanup();
  }
});

test("entrypoint capability matching is exact and template catalog paths cannot escape assets", async () => {
  const fixture = makeFixture();
  try {
    write(
      path.join(fixture.assetsRoot, "capabilities.json"),
      JSON.stringify({
        schema: "preset-capabilities/v1",
        providers: [{ id: "cap:run/v1", kind: "checker", version: "1" }],
      }),
    );
    writePackage(fixture.bundledRoot, "scripted", {
      kind: "process-action",
      entrypoints: {
        run: {
          type: "script",
          intent: "Run",
          inputs: [],
          requires: [{ id: "cap:run/v1", kind: "command", version: "1" }],
          produces: [],
          sideEffects: [],
          command: "run.mjs",
        },
      },
    });
    write(path.join(fixture.bundledRoot, "scripted/run.mjs"), "export {};\n");
    const mismatched = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "scripted",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "script-run",
      entrypoint: "run",
    });
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.error.code, "missing_provider");
    write(
      path.join(fixture.assetsRoot, "template-catalog.json"),
      JSON.stringify(
        templateCatalog([
          {
            id: "planning/task-plan",
            version: "1",
            documentKind: "task-plan",
            slot: "task.plan",
            materializeAs: "task_plan.md",
            frontmatterSchema: "task-package/v2",
            requiredAnchors: [],
            fallbackLocale: "en-US",
            locales: [
              { locale: "en-US", anchors: [], bodyPath: "../escaped.md" },
            ],
          },
        ]),
      ),
    );
    write(
      path.join(path.dirname(fixture.assetsRoot), "escaped.md"),
      "# Escaped\n",
    );
    const escaped = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.equal(escaped.error.code, "missing_template");
  } finally {
    fixture.cleanup();
  }
});

test("whole-package install publishes only the old or new active pointer", async () => {
  const fixture = makeFixture(),
    sourceOld = path.join(path.dirname(fixture.bundledRoot), "source-old"),
    sourceNew = path.join(path.dirname(fixture.bundledRoot), "source-new");
  try {
    writePackage(sourceOld, "standard-task", { version: "3.1.0" });
    writePackage(sourceNew, "standard-task", { version: "3.2.0" });
    installPresetPackage({
      source: path.join(sourceOld, "standard-task"),
      userRoot: fixture.userRoot,
    });
    const version = async () => {
      const result = await createCanonicalPresetResolver({
        bundledRoot: fixture.bundledRoot,
        userRoot: fixture.userRoot,
        assetsRoot: fixture.assetsRoot,
      }).resolve({
        presetId: "standard-task",
        verticalId: "software/coding",
        locale: "en-US",
        purpose: "inspect",
      });
      assert.equal(result.ok, true);
      return result.ok ? result.snapshot.identity.version : "";
    };
    assert.equal(await version(), "3.1.0");
    assert.throws(() =>
      installPresetPackage({
        source: path.join(sourceNew, "standard-task"),
        userRoot: fixture.userRoot,
        killpoint: (point) => {
          if (point === "after-object") throw new Error("kill");
        },
      }),
    );
    assert.equal(await version(), "3.1.0");
    assert.throws(() =>
      installPresetPackage({
        source: path.join(sourceNew, "standard-task"),
        userRoot: fixture.userRoot,
        killpoint: (point) => {
          if (point === "after-pointer") throw new Error("kill");
        },
      }),
    );
    assert.equal(await version(), "3.2.0");
    uninstallPresetPackage({
      presetId: "standard-task",
      userRoot: fixture.userRoot,
    });
    assert.equal(await version(), "3.0.0");
  } finally {
    fixture.cleanup();
  }
});
