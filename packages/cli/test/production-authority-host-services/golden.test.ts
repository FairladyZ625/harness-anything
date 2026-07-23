// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { toCliError } from "../../src/cli/error-mapper.ts";
import { productionAuthorityUnsupportedHint } from "../../src/cli/command-spec/index.ts";
import { productionAuthorityHostServices } from "../../src/composition/production-authority-host-services.ts";
import { captureProductionAuthorityHostEquivalence } from "./equivalence-probe.ts";
import { directProductionAuthorityHostServices } from "./direct-host-services.ts";

const fixtureUrl = new URL("./fixtures/batch5a-parent-differential.json", import.meta.url);

test("all injected production authority host branches match the parent-commit bytes", () => {
  const actual = captureProductionAuthorityHostEquivalence(productionAuthorityHostServices);
  if (process.env.HARNESS_CAPTURE_BATCH5A_GOLDEN === "1") {
    process.stdout.write(`BATCH5A_GOLDEN_START\n${JSON.stringify(actual, null, 2)}\nBATCH5A_GOLDEN_END\n`);
    return;
  }
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
    readonly baselineCommit: string;
    readonly baselineImplementationBlobs: Readonly<Record<string, string>>;
    readonly hostServices: unknown;
  };
  assert.equal(fixture.baselineCommit, "b4db87f72675b78e2dc1f25b803d183610942fa9");
  assert.equal(JSON.stringify(actual), JSON.stringify(fixture.hostServices));
  assert.equal(
    JSON.stringify(actual),
    JSON.stringify(captureProductionAuthorityHostEquivalence(directProductionAuthorityHostServices))
  );
  const repoRoot = new URL("../../../../", import.meta.url);
  for (const [sourcePath, expectedBlobId] of Object.entries(fixture.baselineImplementationBlobs)) {
    const bytes = readFileSync(new URL(sourcePath, repoRoot));
    const header = Buffer.from(`blob ${bytes.byteLength}\0`);
    assert.equal(createHash("sha1").update(header).update(bytes).digest("hex"), expectedBlobId, sourcePath);
  }
});

test("structured daemon unsupported-command data retains the CLI receipt bytes", () => {
  const rejectedKind = "task-claim";
  const rendered = toCliError({
    _tag: "WriteRejected",
    code: "authority_ingress_rejected",
    reason: `AUTHORITY_TYPED_COMMAND_UNSUPPORTED:${rejectedKind}`
  });
  assert.deepEqual(rendered, {
    code: "authority_ingress_rejected",
    hint: `AUTHORITY_TYPED_COMMAND_UNSUPPORTED: ${productionAuthorityUnsupportedHint(rejectedKind)}`
  });
});

test("structured daemon unsupported variants explain the excluded command shape", () => {
  const rendered = toCliError({
    _tag: "WriteRejected",
    code: "authority_ingress_rejected",
    reason: "AUTHORITY_TYPED_COMMAND_UNSUPPORTED:new-task[register-module]"
  });
  assert.deepEqual(rendered, {
    code: "authority_ingress_rejected",
    hint: "AUTHORITY_TYPED_COMMAND_UNSUPPORTED: production canonical ingress rejected new-task variant register-module: inline module registration is a cross-entity composite write; register the module separately before creating the task (decision/dec_01KXSWKWTEXB751A30TRRCQWDG)"
  });
});
