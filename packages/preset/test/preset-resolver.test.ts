// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createCanonicalPresetResolver, installPresetPackage } from "../src/index.ts";
import { decodePresetPackageV3, presetDocumentBody } from "../src/preset-resolver.ts";

import { makeFixture, write, writePackage } from "./preset-resolver.fixtures.ts";
test("canonical resolver decodes one complete bundled package into a content-addressed snapshot", async () => {
  const fixture = makeFixture();
  try {
    const resolver = createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    });
    const result = await resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.schema, "preset-snapshot/v1");
    assert.equal(result.snapshot.identity.layer, "bundled");
    assert.deepEqual(result.snapshot.profile.completionGateIds, ["code-doc-reconciliation"]);
    assert.deepEqual(
      result.snapshot.templates.map((entry) => entry.path),
      ["task_plan.md", "closeout.md", "artifacts/.gitkeep"],
    );
    assert.match(result.snapshot.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.package, null);
  } finally {
    fixture.cleanup();
  }
});

test("new standard coding tasks do not inherit a hosted CI completion gate", async () => {
  const fixture = makeFixture();
  try {
    const resolver = createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    });
    const result = await resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.profile.completionGateIds.includes("ci"), false);
  } finally {
    fixture.cleanup();
  }
});

test("resolver distinguishes unavailable verticals from unavailable presets", async () => {
  const fixture = makeFixture();
  try {
    const resolver = createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    });
    const missingVertical = await resolver.resolve({
      presetId: "standard-task",
      verticalId: "software-coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(missingVertical.ok, false);
    if (!missingVertical.ok) {
      assert.equal(missingVertical.error.code, "missing_vertical");
      assert.match(missingVertical.error.hint, /Available vertical ids: software\/coding\./u);
    }

    const missingPreset = await resolver.resolve({
      presetId: "not-installed",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(missingPreset.ok, false);
    if (!missingPreset.ok) {
      assert.equal(missingPreset.error.code, "preset_not_found");
      const listed = (await resolver.list({ verticalId: "software/coding" })).map(({ id }) => id).sort();
      assert.deepEqual(listed, ["standard-task"]);
      assert.match(
        missingPreset.error.hint,
        /Preset not-installed is unavailable in software\/coding\. Available presets: standard-task\./u,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("missing preset hints exclude presets whose required provider is unavailable", async () => {
  const fixture = makeFixture(),
    sourceRoot = path.join(path.dirname(fixture.bundledRoot), "user-source");
  try {
    writePackage(sourceRoot, "needs-provider", {
      capabilityImports: [{ id: "provider:absent/v1", kind: "checker", version: "1", required: true }],
    });
    installPresetPackage({ source: path.join(sourceRoot, "needs-provider"), userRoot: fixture.userRoot });
    const resolver = createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    });
    // The projected list downgrades the package; the hint must use that same projection.
    const listed = await resolver.list({ verticalId: "software/coding" });
    assert.deepEqual(
      listed.map(({ id, validity }) => ({ id, validity })),
      [
        { id: "needs-provider", validity: "unavailable" },
        { id: "standard-task", validity: "valid" },
      ],
    );

    const missingPreset = await resolver.resolve({
      presetId: "not-installed",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(missingPreset.ok, false);
    if (!missingPreset.ok) {
      assert.equal(missingPreset.error.code, "preset_not_found");
      assert.match(missingPreset.error.hint, /Available presets: standard-task\./u);
      assert.doesNotMatch(missingPreset.error.hint, /needs-provider/u);
    }

    assert.throws(
      () =>
        presetDocumentBody({
          userRoot: fixture.userRoot,
          verticalId: "software/coding",
          presetId: "not-installed",
        }),
      (error: unknown) => {
        const failure = error as { readonly code?: string; readonly message?: string };
        assert.equal(failure.code, "preset_not_found");
        assert.match(failure.message ?? "", /Available presets: .*standard-task/u);
        assert.doesNotMatch(failure.message ?? "", /needs-provider/u);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test("missing preset hint says no presets are installed for an empty catalog", async () => {
  const fixture = makeFixture(),
    emptyBundled = path.join(path.dirname(fixture.bundledRoot), "empty-bundled");
  try {
    mkdirSync(emptyBundled);
    const missingPreset = await createCanonicalPresetResolver({
      bundledRoot: emptyBundled,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "not-installed",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(missingPreset.ok, false);
    if (!missingPreset.ok)
      assert.equal(
        missingPreset.error.hint,
        "Preset not-installed is unavailable in software/coding. No presets are installed for software/coding.",
      );
  } finally {
    fixture.cleanup();
  }
});

test("resolver rejects a production-installed preset outside the canonical vertical", async () => {
  const fixture = makeFixture(),
    sourceRoot = path.join(path.dirname(fixture.bundledRoot), "user-source");
  try {
    writePackage(sourceRoot, "ops-other", { vertical: "ops/other" });
    installPresetPackage({
      source: path.join(sourceRoot, "ops-other"),
      userRoot: fixture.userRoot,
    });
    const result = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "ops-other",
      verticalId: "ops/other",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "missing_vertical");
      assert.match(result.error.hint, /Available vertical ids: software\/coding\./u);
    }
  } finally {
    fixture.cleanup();
  }
});

test("an invalid user package shadows the bundled package without fallback", async () => {
  const fixture = makeFixture();
  try {
    const digest = "d".repeat(64),
      objectRoot = path.join(fixture.userRoot, "preset-objects", digest);
    write(path.join(objectRoot, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3" }));
    write(
      path.join(fixture.userRoot, "active/standard-task.json"),
      JSON.stringify({
        schema: "preset-active-pointer/v1",
        presetId: "standard-task",
        verticalId: "software/coding",
        digest,
      }),
    );
    const resolver = createCanonicalPresetResolver({
        bundledRoot: fixture.bundledRoot,
        userRoot: fixture.userRoot,
        assetsRoot: fixture.assetsRoot,
      }),
      listed = await resolver.list({ verticalId: "software/coding" }),
      result = await resolver.resolve({
        presetId: "standard-task",
        verticalId: "software/coding",
        locale: "en-US",
        purpose: "inspect",
      });
    assert.deepEqual(
      listed.map(({ id, layer, validity, errorCode, missingProviderIds }) => ({
        id,
        layer,
        validity,
        errorCode,
        missingProviderIds,
      })),
      [
        {
          id: "standard-task",
          layer: "user",
          validity: "blocked",
          errorCode: "shadow_invalid",
          missingProviderIds: [],
        },
      ],
    );
    assert.match(listed[0]?.nextAction ?? "", /repair.*shadow_invalid.*ha preset list/iu);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally {
    fixture.cleanup();
  }
});

test(
  "a symbolic-link active pointer blocks the bundled package",
  {
    skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
  },
  async () => {
    const fixture = makeFixture();
    try {
      write(
        path.join(path.dirname(fixture.userRoot), "outside-pointer.json"),
        JSON.stringify({ schema: "preset-active-pointer/v1" }),
      );
      mkdirSync(path.join(fixture.userRoot, "active"), { recursive: true });
      symlinkSync(
        path.join(path.dirname(fixture.userRoot), "outside-pointer.json"),
        path.join(fixture.userRoot, "active/standard-task.json"),
      );
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
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "a symbolic-link pointer blocks the same preset id in every vertical",
  {
    skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
  },
  async () => {
    const fixture = makeFixture();
    try {
      writePackage(fixture.bundledRoot, "other-task", {
        vertical: "other/vertical",
      });
      write(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), "{}");
      mkdirSync(path.join(fixture.userRoot, "active"), { recursive: true });
      symlinkSync(
        path.join(path.dirname(fixture.userRoot), "outside-pointer.json"),
        path.join(fixture.userRoot, "active/other-task.json"),
      );
      const result = await createCanonicalPresetResolver({
        bundledRoot: fixture.bundledRoot,
        userRoot: fixture.userRoot,
        assetsRoot: fixture.assetsRoot,
      }).resolve({
        presetId: "other-task",
        verticalId: "other/vertical",
        locale: "en-US",
        purpose: "inspect",
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
    } finally {
      fixture.cleanup();
    }
  },
);

test("a symbolic-link active inventory root fails closed", async () => {
  const fixture = makeFixture(),
    outsideActive = path.join(path.dirname(fixture.userRoot), "outside-active");
  try {
    mkdirSync(outsideActive, { recursive: true });
    rmSync(path.join(fixture.userRoot, "active"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    symlinkSync(
      outsideActive,
      path.join(fixture.userRoot, "active"),
      process.platform === "win32" ? "junction" : "dir",
    );
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
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_pointer_root");
    assert.throws(
      () =>
        installPresetPackage({
          source: path.join(fixture.bundledRoot, "standard-task"),
          userRoot: fixture.userRoot,
        }),
      (error: unknown) => (error as { code?: string }).code === "invalid_install_root",
    );
    assert.equal(existsSync(path.join(outsideActive, "standard-task.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("an invalid pointer preserves its declared vertical and blocks that bundled shadow", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "other-task", {
      vertical: "other/vertical",
    });
    const digest = "e".repeat(64);
    write(
      path.join(fixture.userRoot, "active/other-task.json"),
      JSON.stringify({
        schema: "preset-active-pointer/v1",
        presetId: "other-task",
        verticalId: "other/vertical",
        digest,
      }),
    );
    const result = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "other-task",
      verticalId: "other/vertical",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally {
    fixture.cleanup();
  }
});

test(
  "package decoder rejects symlinks and missing PRESET or script files",
  {
    skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
  },
  () => {
    const fixture = makeFixture();
    try {
      const complete = path.join(fixture.bundledRoot, "standard-task"),
        missingDocument = path.join(path.dirname(fixture.bundledRoot), "missing-document"),
        missingScript = path.join(path.dirname(fixture.bundledRoot), "missing-script");
      symlinkSync("preset.json", path.join(complete, "manifest-link.json"));
      assert.throws(
        () => decodePresetPackageV3(complete),
        (error: unknown) => (error as { code?: string }).code === "symlink_forbidden",
      );
      write(path.join(missingDocument, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3" }));
      assert.throws(
        () => decodePresetPackageV3(missingDocument),
        (error: unknown) => (error as { code?: string }).code === "missing_preset_document",
      );
      write(
        path.join(missingScript, "preset.json"),
        JSON.stringify({
          schema: "preset-manifest/v3",
          id: "scripted",
          title: "Scripted",
          vertical: "software/coding",
          version: "3.0.0",
          kind: "process-action",
          outputShape: "repository-diff",
          kernelVersionRange: { min: "1.0.0" },
          capabilityImports: [],
          entrypoints: {
            run: {
              type: "script",
              intent: "Run",
              inputs: [],
              requires: [],
              produces: [],
              sideEffects: [],
              command: "scripts/run.mjs",
            },
          },
          profiles: [
            {
              id: "baseline",
              title: "Baseline",
              completionGates: [],
              templateSelections: [],
            },
          ],
          defaultProfile: "baseline",
        }),
      );
      write(
        path.join(missingScript, "PRESET.md"),
        "---\nschema: preset-document/v1\ndescription: Script\nwhenToUse: Run it.\n---\n# Script\n",
      );
      assert.throws(
        () => decodePresetPackageV3(missingScript),
        (error: unknown) => (error as { code?: string }).code === "missing_script",
      );
    } finally {
      fixture.cleanup();
    }
  },
);

test("resolver rejects extends cycles before producing a snapshot", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "cycle-a", { extends: "cycle-b" });
    writePackage(fixture.bundledRoot, "cycle-b", { extends: "cycle-a" });
    const result = await createCanonicalPresetResolver({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolve({
      presetId: "cycle-a",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "inspect",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "extends_cycle");
  } finally {
    fixture.cleanup();
  }
});
