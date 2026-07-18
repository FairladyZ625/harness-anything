import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import type { ProductionCanonicalIngressFixture } from "./fixture.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";

export function verifyDerivedFactSource(
  fixture: ProductionCanonicalIngressFixture,
  env: Readonly<Record<string, string>>
): void {
  const claim = runRawJsonMaybeFail(fixture.repoRoot, ["task", "claim", taskId], env);
  assert.equal(claim.status, 0, JSON.stringify(claim.receipt));
  const executionId = String((claim.receipt.details as {
    readonly data?: { readonly executionId?: string };
  } | undefined)?.data?.executionId ?? "");
  assert.match(executionId, /^exe_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(claim.receipt));

  const recorded = runRawJsonMaybeFail(fixture.repoRoot, [
    "fact", "record", "--task", taskId,
    "--statement", "Production derives fact source from the active execution."
  ], env);
  assert.equal(recorded.status, 0, JSON.stringify(recorded.receipt));
  assert.match(
    readFileSync(path.join(fixture.authoredRoot, `tasks/${taskId}/facts.md`), "utf8"),
    new RegExp(`source: "execution/${taskId}/${executionId}"`, "u")
  );
}
