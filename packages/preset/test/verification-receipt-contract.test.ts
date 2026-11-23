// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1, resolveCompletionContract } from "@harness-anything/kernel";
import { createRuntime, validatePresetPackage, validateVerticalSource } from "../src/preset-resolver.ts";
import { defaultAssets, defaultBundled } from "../src/preset-resolver-common.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("software/coding vertical and standard-task verified profile pass validation and preserve baseline", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-verified-preset-contract-"));
  try {
    const presetReport = validatePresetPackage({ source: path.join(defaultBundled, "standard-task") });
    assert.equal(presetReport.valid, true, JSON.stringify(presetReport.issues));

    const verticalReport = validateVerticalSource({
      source: defaultAssets,
      presetId: "standard-task",
      userRoot,
    });
    assert.equal(verticalReport.valid, true, JSON.stringify(verticalReport.issues));

    const runtime = createRuntime({ userRoot });
    const baseline = await runtime.resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(baseline.ok, true);
    if (baseline.ok) {
      assert.deepEqual(baseline.snapshot.profile.completionGateIds, []);
    }

    const verified = await runtime.resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "verified",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;

    assert.deepEqual(verified.snapshot.profile.completionGateIds, ["verification-receipt"]);
    assert.ok(verified.snapshot.completionPackages["software-coding/verification-receipt"]);

    const resolvedContract = resolveCompletionContract(
      verified.snapshot.profile.completionGateIds,
      { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
      { digest: verified.snapshot.digest, completion: verified.snapshot.completion },
    );
    assert.equal(resolvedContract.ok, true);
    if (!resolvedContract.ok) return;

    assert.equal(resolvedContract.contract.gates.length, 1);
    const gate = resolvedContract.contract.gates[0]!;
    assert.equal(gate.gateId, "verification-receipt");
    assert.equal(gate.appliesTo, "submission");
    assert.deepEqual(gate.subjects, ["artifacts/verification-receipt.json"]);
    assert.equal(gate.witness.kind, "command");
    assert.deepEqual(Object.keys(gate.bindings ?? {}).sort(), [
      "commitSha",
      "failed",
      "passed",
      "timedOut",
      "total",
      "unexecuted",
    ]);

    const presetDoc = readFileSync(path.join(defaultBundled, "standard-task", "PRESET.md"), "utf8");
    assert.match(presetDoc, /--profile verified/u);
    assert.match(presetDoc, /artifacts\/verification-receipt\.json/u);
  } finally {
    removeTempRepository(userRoot);
  }
});

test("verify-receipt script rejects missing, archive-only, malformed, and invalid receipts and prefers root receipt", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-verify-receipt-script-")),
    scriptPath = path.join(defaultBundled, "standard-task", "checks", "verify-receipt.mjs"),
    commitSha = "a".repeat(40),
    blobSha256 = "b".repeat(64);
  const runScript = (witnessInput: Record<string, unknown>) => {
    const inputDir = path.join(sandbox, "input");
    mkdirSync(inputDir, { recursive: true });
    const witnessPath = path.join(inputDir, "witness.json");
    writeFileSync(witnessPath, JSON.stringify(witnessInput));
    const stdout = execFileSync(
      process.execPath,
      ["--permission", `--allow-fs-read=${sandbox}/*`, `--allow-fs-read=${path.dirname(scriptPath)}/*`, scriptPath],
      {
        cwd: sandbox,
        encoding: "utf8",
        env: { ...process.env, HA_PRESET_INPUT: JSON.stringify({ witnessInput: witnessPath }) },
      },
    );
    const parsed = JSON.parse(stdout) as {
      schema: string;
      produces: Array<{
        capabilityId: string;
        payload: {
          result: "pass" | "fail";
          subjects: Array<{ path: string }>;
          predicateType: string;
          predicate: Record<string, unknown>;
          diagnostic: string;
        };
      }>;
    };
    assert.equal(parsed.schema, "preset-script-result/v1");
    assert.equal(parsed.produces[0]?.capabilityId, "completion-witness");
    if (parsed.produces[0]?.payload.result === "fail") {
      assert.ok(
        Buffer.byteLength(stdout, "utf8") < 1024,
        `expected raw stdout fail frame < 1024B, got ${Buffer.byteLength(stdout, "utf8")}`,
      );
    }
    return { payload: parsed.produces[0]!.payload, rawBytes: Buffer.byteLength(stdout, "utf8") };
  };
  try {
    // 1. Missing receipt -> script emits explicit fail
    const missing = runScript({
      schema: "witness-input/v1",
      code: { commitSha, directory: "input/code" },
      subjects: [],
    }).payload;
    assert.equal(missing.result, "fail");
    assert.match(missing.diagnostic, /Missing required verification receipt artifact/u);

    // 2. Archive alias only -> must not satisfy root receipt requirement
    const archiveReceiptFile = path.join(sandbox, "archive-receipt.json");
    writeFileSync(
      archiveReceiptFile,
      JSON.stringify({ commitSha, passed: 5, failed: 0, timedOut: 0, unexecuted: 0, total: 5 }),
    );
    const archiveOnly = runScript({
      schema: "witness-input/v1",
      code: { commitSha, directory: "input/code" },
      subjects: [
        {
          path: "tasks/task-example/artifacts/archive/artifacts/verification-receipt.json",
          revision: 1,
          blobSha256,
          file: archiveReceiptFile,
        },
      ],
    }).payload;
    assert.equal(archiveOnly.result, "fail");
    assert.match(archiveOnly.diagnostic, /Missing required verification receipt artifact/u);

    // 3. Archive alias sorted before root receipt -> selects root receipt instead of earlier archive alias
    writeFileSync(
      archiveReceiptFile,
      JSON.stringify({ commitSha: "0".repeat(40), passed: 1, failed: 0, timedOut: 0, unexecuted: 1, total: 2 }),
    );
    const rootReceiptFile = path.join(sandbox, "root-receipt.json");
    writeFileSync(
      rootReceiptFile,
      JSON.stringify({ commitSha, passed: 8, failed: 0, timedOut: 0, unexecuted: 0, total: 8 }),
    );
    const rootPreferred = runScript({
      schema: "witness-input/v1",
      code: { commitSha, directory: "input/code" },
      subjects: [
        {
          path: "tasks/task-example/artifacts/archive/artifacts/verification-receipt.json",
          revision: 1,
          blobSha256,
          file: archiveReceiptFile,
        },
        {
          path: "tasks/task-example/artifacts/verification-receipt.json",
          revision: 1,
          blobSha256,
          file: rootReceiptFile,
        },
      ],
    }).payload;
    assert.equal(rootPreferred.result, "pass");
    assert.equal(rootPreferred.predicate.passed, 8);

    // 4. Malformed JSON, non-object JSON, float count, timedOut > 0, artifact-only null sha
    const badFile = path.join(sandbox, "bad.json");
    writeFileSync(badFile, "{not-json");
    assert.equal(
      runScript({
        schema: "witness-input/v1",
        code: { commitSha, directory: "input/code" },
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      }).payload.result,
      "fail",
    );

    writeFileSync(badFile, "[]");
    assert.equal(
      runScript({
        schema: "witness-input/v1",
        code: { commitSha, directory: "input/code" },
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      }).payload.result,
      "fail",
    );

    writeFileSync(
      badFile,
      JSON.stringify({ commitSha, passed: 1.5, failed: 0, timedOut: 0, unexecuted: 0, total: 1.5 }),
    );
    assert.equal(
      runScript({
        schema: "witness-input/v1",
        code: { commitSha, directory: "input/code" },
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      }).payload.result,
      "fail",
    );

    for (const [rawFailed, rawTotal, expectedToken] of [
      ["0", "1.0000000000000001", "1.0000000000000001"],
      ["1e-324", "1", "1e-324"],
      ["-1e-324", "1", "-1e-324"],
    ]) {
      writeFileSync(
        badFile,
        `{"commitSha":"${commitSha}","passed":1,"failed":${rawFailed},"timedOut":0,"unexecuted":0,"total":${rawTotal}}`,
      );
      const precisionFail = runScript({
        schema: "witness-input/v1",
        code: { commitSha, directory: "input/code" },
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      });
      assert.equal(precisionFail.payload.result, "fail");
      assert.deepEqual(precisionFail.payload.predicate, {});
      assert.ok(precisionFail.payload.diagnostic.includes(expectedToken), precisionFail.payload.diagnostic);
      assert.ok(precisionFail.rawBytes < 1024, `expected rawBytes < 1024, got ${precisionFail.rawBytes}`);
    }

    writeFileSync(badFile, JSON.stringify({ commitSha, passed: 5, failed: 0, timedOut: 1, unexecuted: 0, total: 6 }));
    assert.equal(
      runScript({
        schema: "witness-input/v1",
        code: { commitSha, directory: "input/code" },
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      }).payload.result,
      "fail",
    );

    // Duplicate top-level JSON keys (including unicode-escaped duplicates) cannot shadow earlier failures
    for (const dupJson of [
      `{"commitSha":"${commitSha}","passed":1,"failed":1,"failed":0,"timedOut":0,"unexecuted":0,"total":1}`,
      `{"commitSha":"${commitSha}","passed":1,"\\u0066ailed":1,"failed":0,"timedOut":0,"unexecuted":0,"total":1}`,
    ]) {
      writeFileSync(badFile, dupJson);
      const dupResult = runScript({
        schema: "witness-input/v1",
        code: { commitSha, directory: "input/code" },
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      });
      assert.equal(dupResult.payload.result, "fail");
      assert.deepEqual(dupResult.payload.predicate, {});
      assert.match(dupResult.payload.diagnostic, /Duplicate top-level key "failed"/u);
    }

    // Exact mathematical integer encodings (1.0, 1e0, -0, -0.0, -0e5) and deep unbound metadata pass cleanly
    const deepMetadata = `${"[".repeat(4_000)}0${"]".repeat(4_000)}`;
    writeFileSync(
      badFile,
      `{"commitSha":"${commitSha}","passed":1.0,"failed":-0.0,"timedOut":-0,"unexecuted":-0e5,"total":1e0,"metadata":${deepMetadata}}`,
    );
    const exactEncodedPass = runScript({
      schema: "witness-input/v1",
      code: { commitSha, directory: "input/code" },
      subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
    });
    assert.equal(exactEncodedPass.payload.result, "pass", exactEncodedPass.payload.diagnostic);
    assert.equal(exactEncodedPass.payload.predicate.passed, 1);
    assert.equal(exactEncodedPass.payload.predicate.total, 1);

    // 5. Oversized wrong-type field + 6 multi-byte escaped invalid fields -> raw stdout frame strictly < 1024B
    writeFileSync(
      badFile,
      JSON.stringify({ commitSha: ["x".repeat(40_000)], passed: 1, failed: 0, timedOut: 0, unexecuted: 0, total: 1 }),
    );
    const oversizedField = runScript({
      schema: "witness-input/v1",
      code: { commitSha, directory: "input/code" },
      subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
    });
    assert.equal(oversizedField.payload.result, "fail");
    assert.deepEqual(oversizedField.payload.predicate, {});
    assert.match(oversizedField.payload.diagnostic, /array\(length=1\)/u);
    assert.ok(oversizedField.rawBytes < 1024, `expected rawBytes < 1024, got ${oversizedField.rawBytes}`);

    const nonAsciiEscaped = '测"\n\\\t🔥'.repeat(11);
    writeFileSync(
      badFile,
      JSON.stringify({
        commitSha: nonAsciiEscaped,
        passed: nonAsciiEscaped,
        failed: nonAsciiEscaped,
        timedOut: nonAsciiEscaped,
        unexecuted: nonAsciiEscaped,
        total: nonAsciiEscaped,
      }),
    );
    const multiByteFail = runScript({
      schema: "witness-input/v1",
      code: { commitSha, directory: "input/code" },
      subjects: [
        {
          path: "tasks/task-verified-code-verified-coding-task/artifacts/verification-receipt.json",
          revision: 35,
          blobSha256,
          file: badFile,
        },
      ],
    });
    assert.equal(multiByteFail.payload.result, "fail");
    assert.deepEqual(multiByteFail.payload.predicate, {});
    assert.ok(multiByteFail.rawBytes < 1024, `expected multi-byte rawBytes < 1024, got ${multiByteFail.rawBytes}`);

    writeFileSync(
      badFile,
      JSON.stringify({ commitSha: null, passed: 3, failed: 0, timedOut: 0, unexecuted: 0, total: 3 }),
    );
    assert.equal(
      runScript({
        schema: "witness-input/v1",
        code: null,
        subjects: [{ path: "artifacts/verification-receipt.json", revision: 1, blobSha256, file: badFile }],
      }).payload.result,
      "pass",
    );
  } finally {
    removeTempRepository(sandbox);
  }
});
