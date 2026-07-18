import assert from "node:assert/strict";
import type { ProductionCanonicalIngressFixture } from "./fixture.ts";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";

export function verifySluggedTaskRelatePathCas(
  fixture: ProductionCanonicalIngressFixture,
  env: Readonly<Record<string, string>>
): void {
  const result = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "relate", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8", "depends-on",
    "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--rationale", "Slugged portable-path CAS parity."
  ], env);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
  assert.equal(result.receipt.ok, true, JSON.stringify(result.receipt));
}
