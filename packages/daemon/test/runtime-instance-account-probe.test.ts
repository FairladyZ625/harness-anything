// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findExhaustedSubscriptionQuotaWindow } from "@harness-anything/kernel";
import { createRuntimeInstanceAccountProbe } from "../src/daemon-host/runtime-instance-account-probe.ts";
import { parseAgyQuotaResponse } from "../src/daemon-host/runtime-subscription-quota-probe.ts";
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
      const quota = await probe.probeQuota({ ...input, kindId: "agy", credentialSource: "instance" });
      assert.ok(quota);
      assert.equal(findExhaustedSubscriptionQuotaWindow(quota)?.resetAt, resetAt);
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
  await assert.rejects(probe.probeQuota({ ...input, kindId: "agy", credentialSource: "instance" }), missingHome);
});

test("AGY quota parsing supports both /quota command wrappers and /usage data/top-level shapes", () => {
  const later = "2026-11-16T04:05:06.000Z";
  const fromQuotaCommand = parseAgyQuotaResponse(
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
  assert.equal(findExhaustedSubscriptionQuotaWindow(fromQuotaCommand)?.resetAt, later);

  // >=1.2.2 `/usage --output-format json` with `data.groups[]` and camelCase/percent fields.
  const fromUsageData = parseAgyQuotaResponse(
    JSON.stringify({
      data: {
        tier: "Pro",
        groups: [
          {
            group_id: "gemini",
            display_name: "Gemini",
            buckets: [{ id: "5h", display_name: "5h", remainingFraction: 0.42, resets_at: later }],
          },
        ],
      },
    }),
    "2026-11-15T00:00:00.000Z",
  );
  assert.equal(fromUsageData.plan, "Pro");
  assert.equal(fromUsageData.windows[0]?.remainingFraction, 0.42);
  assert.equal(fromUsageData.windows[0]?.resetsAt, later);

  // Bare top-level `groups[]` shape with `remaining_percent`.
  const fromBareGroups = parseAgyQuotaResponse(
    JSON.stringify({
      plan_name: "Ultra",
      groups: [
        {
          name: "Claude",
          buckets: [{ name: "Weekly", remaining_percent: 0.4, reset_time: later }],
        },
      ],
    }),
    "2026-11-15T00:00:00.000Z",
  );
  assert.equal(fromBareGroups.plan, "Ultra");
  assert.equal(fromBareGroups.windows[0]?.remainingFraction, 0.004);
  assert.equal(findExhaustedSubscriptionQuotaWindow(fromBareGroups, "2026-11-15T00:00:00.000Z"), null);
});

test("AGY quota parser rejects malformed /quota and /usage response shapes", () => {
  const invalidShape = (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "runtime_quota_response_invalid";
  assert.throws(() => parseAgyQuotaResponse("not-json"), invalidShape);
  assert.throws(() => parseAgyQuotaResponse("[]"), invalidShape);
  assert.throws(() => parseAgyQuotaResponse(JSON.stringify({ command: { data: { groups: [] } } })), invalidShape);
  assert.throws(
    () => parseAgyQuotaResponse(JSON.stringify({ data: { groups: [{ name: "missing-buckets" }] } })),
    invalidShape,
  );
  assert.throws(
    () => parseAgyQuotaResponse(JSON.stringify({ groups: [{ buckets: [{ remaining_fraction: "bad" }] }] })),
    invalidShape,
  );
  assert.throws(() => parseAgyQuotaResponse(JSON.stringify({ unexpected: true })), invalidShape);
});
