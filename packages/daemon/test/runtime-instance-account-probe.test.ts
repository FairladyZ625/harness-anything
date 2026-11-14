// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeInstanceAccountProbe, quotaResetTime } from "../src/runtime-instance-account-probe.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test("AGY account model probes are bounded and abort while waiting for a slot", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-account-probe-")),
    bin = path.join(root, "bin"),
    trace = path.join(root, "trace.jsonl");
  mkdirSync(bin, { recursive: true });
  const agy = writeProviderExecutable(
    path.join(bin, "agy"),
    `
      const fs = require("node:fs");
      const home = process.env.HOME ?? "";
      const args = process.argv.slice(2);
      if (args[0] !== "acp" && (args.includes("--gemini-dir") || args.includes("--app-data-dir"))) {
        console.error("Error: flags provided but not defined: -gemini-dir");
        process.exit(1);
      }
      if (args[0] !== "models") process.exit(31);
      fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ kind: "start", home }) + "\\n");
      setTimeout(() => {
        fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ kind: "end", home }) + "\\n");
        console.log((home.includes("pro") ? "gemini-4-hydrogen-low" : "gemini-4-carbon-low") + "\\tmodel");
      }, 80);
    `,
  );
  writeFileSync(trace, "");
  try {
    const probe = createRuntimeInstanceAccountProbe(process.platform, 1),
      first = probe.probeModels({
        kindId: "agy",
        executablePath: agy,
        env: { PATH: bin, HOME: "/runtime/ultra/home", PROBE_TRACE: trace },
      }),
      queued = probe.probeModels({
        kindId: "agy",
        executablePath: agy,
        env: { PATH: bin, HOME: "/runtime/pro/home", PROBE_TRACE: trace },
        signal: AbortSignal.timeout(15),
      });
    const [catalog] = await Promise.all([first, assert.rejects(queued, { name: "TimeoutError" })]);
    assert.deepEqual(catalog?.models, ["gemini-4-carbon-low"]);
    const events = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly kind: string; readonly home: string });
    assert.deepEqual(
      events.map(({ kind }) => kind),
      ["start", "end"],
    );
    assert.ok(events.every(({ home }) => home === "/runtime/ultra/home"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGY models and quota use HOME or USERPROFILE without ACP directory flags", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-account-home-")),
    resetAt = "2026-11-16T04:05:06.000Z",
    agy = writeProviderExecutable(
      path.join(root, "agy"),
      `
        const args = process.argv.slice(2);
        if (args[0] !== "acp" && (args.includes("--gemini-dir") || args.includes("--app-data-dir"))) {
          console.error("Error: flags provided but not defined: -gemini-dir");
          process.exit(1);
        }
        if ((process.env.HOME ?? process.env.USERPROFILE) !== process.env.EXPECTED_HOME) process.exit(31);
        if (args[0] === "models") console.log("gemini-4-hydrogen-low\\tmodel");
        else if (JSON.stringify(args) === JSON.stringify(["-p", "/quota", "--output-format", "json"]))
          console.log(JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: 0, reset_time: ${JSON.stringify(resetAt)} }] }] } } }));
        else process.exit(32);
      `,
    );
  try {
    const probe = createRuntimeInstanceAccountProbe(process.platform);
    for (const variable of ["HOME", "USERPROFILE"] as const) {
      const home = path.join(root, variable, "home"),
        input = { executablePath: agy, env: { [variable]: home, EXPECTED_HOME: home } };
      const catalog = await probe.probeModels({ ...input, kindId: "agy" });
      assert.deepEqual(catalog?.models, ["gemini-4-hydrogen-low"]);
      assert.equal(await probe.probeAgyQuota(input), resetAt);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGY models and quota reject a missing account HOME before launching the CLI", async () => {
  const probe = createRuntimeInstanceAccountProbe(process.platform),
    input = { executablePath: "/must-not-launch/agy", env: {} },
    missingHome = (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "runtime_auth_probe_failed";
  await assert.rejects(probe.probeModels({ ...input, kindId: "agy" }), missingHome);
  await assert.rejects(probe.probeAgyQuota(input), missingHome);
});

test("AGY quota parsing selects the latest reset among exhausted buckets", () => {
  const later = "2026-11-16T04:05:06.000Z",
    reset = quotaResetTime(
      JSON.stringify({
        command: {
          data: {
            groups: [
              { buckets: [{ remaining_fraction: 0, reset_time: "2026-11-15T00:00:00.000Z" }] },
              {
                buckets: [
                  { remaining_fraction: 0.25, reset_time: later },
                  { remaining_fraction: 0, reset_time: later },
                  { remaining_fraction: 0, reset_time: Date.parse("2026-11-16T00:00:00.000Z") / 1_000 },
                ],
              },
            ],
          },
        },
      }),
    );
  assert.equal(reset, later);
});

test("AGY quota parser rejects malformed response shapes", () => {
  assert.throws(
    () => quotaResetTime("not-json"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_quota_response_invalid",
  );
  assert.throws(
    () => quotaResetTime(JSON.stringify({ command: { data: { groups: [] } } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_quota_response_invalid",
  );
});
