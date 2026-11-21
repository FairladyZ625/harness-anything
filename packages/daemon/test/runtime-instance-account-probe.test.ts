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
  assert.throws(
    () =>
      parseAgyQuotaResponse(
        JSON.stringify({ ok: false, command: { name: "usage", ok: false, error: "not logged in" } }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "usage" },
      ),
    invalidShape,
  );
  assert.throws(
    () =>
      parseAgyQuotaResponse(
        JSON.stringify({
          command: { name: "other", data: { groups: [{ buckets: [{ remaining_fraction: 0.5 }] }] } },
        }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "usage" },
      ),
    invalidShape,
  );
});

test("AGY quota probe prefers /usage with nested remaining.remaining_fraction, skips null buckets, enforces non-interactive env, and avoids browser launch on expired login", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-usage-")),
    traceFile = path.join(root, "trace.jsonl"),
    browserMarker = path.join(root, "browser-launched"),
    resetAt = "2026-11-22T06:00:00.000Z";
  writeFileSync(traceFile, "");
  const agyUsage = writeProviderExecutable(
    path.join(root, "agy-usage"),
    `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
        args,
        ci: process.env.CI,
        browser: process.env.BROWSER,
        noBrowser: process.env.NO_BROWSER,
        noAutoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
        noUpdateNotifier: process.env.NO_UPDATE_NOTIFIER,
        ssh: Boolean(process.env.SSH_CONNECTION),
      }) + "\\n");
      if (process.env.EXPIRED_LOGIN === "1") {
        // A real CLI would only attempt browser launch when BROWSER !== "false" and CI !== "1".
        if (process.env.BROWSER !== "false" || process.env.CI !== "1" || process.env.NO_BROWSER !== "1") {
          fs.writeFileSync(${JSON.stringify(browserMarker)}, "launched");
        }
        console.log(JSON.stringify({ ok: false, command: { name: args[1].slice(1), ok: false, error: "login expired" } }));
        process.exit(1);
      }
      if (args[1] === "/usage") {
        console.log(JSON.stringify({
          ok: true,
          command: {
            name: "usage",
            ok: true,
            data: {
              plan: "Pro",
              groups: [
                {
                  group_id: "gemini",
                  display_name: "Gemini",
                  models: ["gemini-4-hydrogen-low"],
                  buckets: [
                    { bucket_id: "unmetered", display_name: "Unmetered", remaining: { remaining_fraction: null } },
                    { bucket_id: "gemini-weekly", display_name: "Weekly", remaining: { remaining_fraction: 0.77, reset_time: ${JSON.stringify(resetAt)} } }
                  ]
                }
              ]
            }
          }
        }));
        process.exit(0);
      }
      process.exit(2);
    `,
  );
  try {
    const probe = createRuntimeInstanceAccountProbe(process.platform);
    const home = path.join(root, "home");
    const quota = await probe.probeQuota({
      kindId: "agy",
      credentialSource: "instance",
      executablePath: agyUsage,
      env: { HOME: home },
      now: () => "2026-11-21T10:00:00.000Z",
    });
    assert.ok(quota);
    assert.equal(quota.plan, "Pro");
    assert.equal(quota.windows.length, 1);
    assert.equal(quota.windows[0]?.id, "gemini-weekly");
    assert.equal(quota.windows[0]?.remainingFraction, 0.77);
    assert.equal(quota.windows[0]?.resetsAt, resetAt);
    assert.deepEqual(quota.windows[0]?.models, ["gemini-4-hydrogen-low"]);

    const events = readFileSync(traceFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.length, 1, "/usage succeeded without falling back to /quota");
    assert.deepEqual(events[0]?.args, ["-p", "/usage", "--output-format", "json"]);
    assert.equal(events[0]?.ci, "1");
    assert.equal(events[0]?.browser, "false");
    assert.equal(events[0]?.noBrowser, "1");
    assert.equal(events[0]?.noAutoUpdate, "1");
    assert.equal(events[0]?.noUpdateNotifier, "1");
    assert.equal(events[0]?.ssh, true);

    // Expired login fails closed without launching a browser.
    await assert.rejects(
      probe.probeQuota({
        kindId: "agy",
        credentialSource: "instance",
        executablePath: agyUsage,
        env: { HOME: home, EXPIRED_LOGIN: "1" },
        now: () => "2026-11-21T10:00:00.000Z",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_quota_probe_failed",
    );
    assert.throws(() => readFileSync(browserMarker, "utf8"), /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
