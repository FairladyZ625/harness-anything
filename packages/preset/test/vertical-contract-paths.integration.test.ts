// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRuntime, runVerticalDiscoveryAction, validateVerticalSource } from "../src/preset-resolver.ts";
import { makeFixture, write } from "./preset-resolver.fixtures.ts";

test("validate, discovery, and create materialization accept one compiled custom vertical source", async () => {
  const fixture = makeFixture();
  try {
    const verticalPath = path.join(fixture.assetsRoot, "vertical.json"),
      validation = validateVerticalSource({ source: verticalPath });
    assert.equal(validation.available, true);
    assert.equal(validation.valid, true);
    assert.equal(validation.source, verticalPath);
    assert.equal(validation.vertical?.id, "software/coding");

    const scripts = runVerticalDiscoveryAction({ kind: "script-list" }, fixture.assetsRoot) as Array<{
      readonly id: string;
    }>;
    assert.equal(
      scripts.some(({ id }) => id === "vertical:software-coding:architecture-check"),
      true,
    );

    const result = await createRuntime({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.snapshot.templates.map(({ path: documentPath }) => documentPath),
        ["task_plan.md", "closeout.md", "artifacts/.gitkeep"],
      );
    }
  } finally {
    fixture.cleanup();
  }
});

for (const counterexample of [
  {
    name: "duplicate idPrefix",
    mutate(vertical: VerticalJson) {
      const adr = artifact(vertical);
      vertical.entityKinds.push({
        ...adr,
        id: "research-report",
        store: { pathTemplate: "entities/research-reports/{id}.json" },
      });
    },
    message: /Duplicate artifact idPrefix: ADR/u,
  },
  {
    name: "non-portable store path",
    mutate(vertical: VerticalJson) {
      artifact(vertical).store = { pathTemplate: "../outside/{id}.json" };
    },
    message: /normalized portable relative path/u,
  },
  {
    name: "relation verb outside the code vocabulary",
    mutate(vertical: VerticalJson) {
      artifact(vertical).relations = [
        {
          type: "invented-by",
          sourceKind: "architecture-decision-record",
          targetKind: "decision",
          decisionClaimRef: "decision/dec_governance/CH1",
        },
      ];
    },
    message: /invented-by/u,
  },
] as const) {
  test(`all three compiled vertical consumers fail closed on ${counterexample.name}`, async () => {
    const fixture = makeFixture();
    try {
      const verticalPath = path.join(fixture.assetsRoot, "vertical.json"),
        vertical = JSON.parse(readFileSync(verticalPath, "utf8")) as VerticalJson;
      counterexample.mutate(vertical);
      write(verticalPath, JSON.stringify(vertical, null, 2));

      const validation = validateVerticalSource({ source: verticalPath });
      assert.equal(validation.available, true);
      assert.equal(validation.valid, false);
      assert.deepEqual(
        validation.issues.map(({ code }) => code),
        ["invalid_vertical"],
      );
      assert.match(validation.issues[0]?.message ?? "", counterexample.message);

      assert.throws(
        () => runVerticalDiscoveryAction({ kind: "script-list" }, fixture.assetsRoot),
        (error: unknown) =>
          (error as { code?: string }).code === "invalid_vertical" &&
          counterexample.message.test(error instanceof Error ? error.message : String(error)),
      );

      const createResult = await createRuntime({
        bundledRoot: fixture.bundledRoot,
        userRoot: fixture.userRoot,
        assetsRoot: fixture.assetsRoot,
      }).resolver.resolve({
        presetId: "standard-task",
        verticalId: "software/coding",
        profileId: "baseline",
        locale: "en-US",
        purpose: "task-create",
      });
      assert.equal(createResult.ok, false);
      if (!createResult.ok) {
        assert.equal(createResult.error.code, "invalid_vertical");
        assert.match(createResult.error.hint, counterexample.message);
      }
    } finally {
      fixture.cleanup();
    }
  });
}

interface VerticalJson {
  readonly entityKinds: Array<Record<string, unknown>>;
}

function artifact(vertical: VerticalJson): Record<string, unknown> & {
  store: Record<string, unknown>;
  relations: unknown[];
} {
  const value = vertical.entityKinds.find((candidate) => candidate.entityType === "artifact");
  assert.ok(value);
  return value as Record<string, unknown> & { store: Record<string, unknown>; relations: unknown[] };
}
