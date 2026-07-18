import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import {
  authorityOperationRecords,
  type ProductionCanonicalIngressFixture
} from "./fixture.ts";

export function verifyProductionPresetIngress(
  fixture: ProductionCanonicalIngressFixture,
  env: Readonly<Record<string, string>>
): void {
  const presetOperationCount = authorityOperationRecords(fixture.serviceRoot).length;
  const presetEntrypoint = runRawJsonMaybeFail(fixture.repoRoot, [
    "preset", "action", "production-artifact-scaffold", "scaffold",
    "--task", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--allow-scripts"
  ], env);
  assert.equal(presetEntrypoint.status, 0, JSON.stringify(presetEntrypoint.receipt));
  assert.equal(presetEntrypoint.receipt.ok, true, JSON.stringify(presetEntrypoint.receipt));
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, presetOperationCount + 1,
    "one declared script ingest must remain one canonical authority operation");
  assert.equal(existsSync(path.join(
    fixture.authoredRoot,
    "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/artifacts/production-scaffold.md"
  )), true);

  const scriptOperationCount = authorityOperationRecords(fixture.serviceRoot).length;
  const scriptRun = runRawJsonMaybeFail(fixture.repoRoot, [
    "script", "run", "preset:production-artifact-scaffold:scaffold",
    "--task", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG6"
  ], env);
  assert.equal(scriptRun.status, 0, JSON.stringify(scriptRun.receipt));
  assert.equal(scriptRun.receipt.ok, true, JSON.stringify(scriptRun.receipt));
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, scriptOperationCount + 1,
    "script run must submit its declared artifact batch through one canonical operation");
  assert.equal(readFileSync(path.join(
    fixture.authoredRoot,
    "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG6/artifacts/production-scaffold.md"
  ), "utf8"), "# Production scaffold\n\nTask: task_01KXQ4WTA7Q4XJ5GDDRS1YXNG6\n");
}
