// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createProductionAuthorityLifecycleFixture as createFixture,
  productionWriterRuntime as writerRuntime
} from "./helpers/production-authority-lifecycle-fixture.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "../src/composition/production-authority-lifecycle.ts";

test("production lifecycle passes the daemon user root to machine-only identity loading", async () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "machine-user-root");
  try {
    rmSync(path.join(fixture.authoredRoot, "people.yaml"));
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(path.join(userRoot, "people.yaml"), [
      "schema: harness-people/v1",
      "people:",
      "  - personId: person_machine",
      "    displayName: Machine",
      "    roles: [owner]",
      "    credentials: []",
      "roles:",
      "  - roleId: owner",
      "    commandClasses: [admin, repo-write, repo-read, arbiter]",
      ""
    ].join("\n"));

    const lifecycle = createProductionAuthorityLifecycle({
      manifestPath: fixture.manifestPath,
      userRoot
    });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
