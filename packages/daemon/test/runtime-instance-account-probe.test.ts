// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findExhaustedSubscriptionQuotaWindow } from "@harness-anything/kernel";
import { createRuntimeInstanceAccountProbe } from "../src/daemon-host/runtime-instance-account-probe.ts";
import { parseAgyQuotaResponse } from "../src/daemon-host/runtime-subscription-quota-probe.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
    removeTempRepository(root);
  }
});

test("AGY models and quota use HOME or USERPROFILE without ACP directory flags, and quota stages an ephemeral home that protects real credentials from mutation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-account-home-")),
    resetAt = "2026-11-16T04:05:06.000Z",
    stagedHomeTrace = path.join(root, "staged-homes.jsonl"),
    agy = writeProviderExecutable(
      path.join(root, "agy"),
      `
        const fs = require("node:fs");
        const path = require("node:path");
        const args = process.argv.slice(2);
        if (args[0] !== "acp" && (args.includes("--gemini-dir") || args.includes("--app-data-dir"))) {
          console.error("Error: flags provided but not defined: -gemini-dir");
          process.exit(1);
        }
        const effectiveHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
        if (args[0] === "models") {
          if (effectiveHome !== process.env.EXPECTED_HOME) process.exit(31);
          console.log("gemini-4-hydrogen-low\\tmodel");
        } else if (JSON.stringify(args) === JSON.stringify(["-p", "/quota", "--output-format", "json"])) {
          // Verify staged copy of real credential is readable and deliberately attempt to overwrite it.
          const tokenPath = path.join(effectiveHome, ".gemini", "antigravity-oauth-token");
          if (fs.readFileSync(tokenPath, "utf8") !== process.env.EXPECTED_TOKEN) process.exit(33);
          fs.writeFileSync(tokenPath, "mutated-by-proactive-refresh");
          fs.appendFileSync(${JSON.stringify(stagedHomeTrace)}, effectiveHome + "\\n");
          console.log(JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: 0, reset_time: ${JSON.stringify(resetAt)} }] }] } } }));
        } else process.exit(32);
      `,
    );
  try {
    const probe = createRuntimeInstanceAccountProbe(process.platform);
    for (const variable of ["HOME", "USERPROFILE"] as const) {
      const home = path.join(root, variable, "home"),
        geminiDir = path.join(home, ".gemini"),
        tokenFile = path.join(geminiDir, "antigravity-oauth-token"),
        tokenBody = `agy-original-token-${variable}`,
        input = { executablePath: agy, env: { [variable]: home, EXPECTED_HOME: home, EXPECTED_TOKEN: tokenBody } };
      mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
      writeFileSync(tokenFile, tokenBody, { mode: 0o600 });
      const statBefore = statSync(tokenFile);
      const catalog = await probe.probeModels({ ...input, kindId: "agy" });
      assert.deepEqual(catalog?.models, ["gemini-4-hydrogen-low"]);
      const quota = await probe.probeQuota({ ...input, kindId: "agy", credentialSource: "instance" });
      assert.ok(quota);
      assert.equal(findExhaustedSubscriptionQuotaWindow(quota)?.resetAt, resetAt);
      // Real AGY credential file, mtime, and inode MUST stay completely untouched!
      assert.equal(readFileSync(tokenFile, "utf8"), tokenBody);
      const statAfter = statSync(tokenFile);
      assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
      assert.equal(statAfter.ino, statBefore.ino);
    }
    // Every ephemeral staged directory must be distinct from real homes and cleaned up in finally.
    const stagedHomes = readFileSync(stagedHomeTrace, "utf8").trim().split("\n");
    assert.equal(stagedHomes.length, 2);
    for (const stagedHome of stagedHomes) {
      assert.equal(existsSync(stagedHome), false, `ephemeral AGY probe home was not cleaned up: ${stagedHome}`);
    }
  } finally {
    removeTempRepository(root);
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
        JSON.stringify({
          status: "ERROR",
          command: { name: "usage", data: { groups: [{ buckets: [{ remaining_fraction: 0.9 }] }] } },
        }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "usage" },
      ),
    invalidShape,
  );
  assert.throws(
    () =>
      parseAgyQuotaResponse(
        JSON.stringify({
          ok: true,
          command: { name: "usage", data: { groups: [{ buckets: [{ remaining_fraction: 0.9 }] }] } },
        }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "usage" },
      ),
    invalidShape,
  );
  assert.throws(
    () =>
      parseAgyQuotaResponse(
        JSON.stringify({
          status: "SUCCESS",
          data: { groups: [{ buckets: [{ remaining_fraction: 0.9 }] }] },
        }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "usage" },
      ),
    invalidShape,
  );
  assert.throws(
    () =>
      parseAgyQuotaResponse(
        JSON.stringify({
          status: "SUCCESS",
          command: { name: "other", data: { groups: [{ buckets: [{ remaining_fraction: 0.5 }] }] } },
        }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "usage" },
      ),
    invalidShape,
  );
  assert.throws(
    () =>
      parseAgyQuotaResponse(
        JSON.stringify({
          status: "ERROR",
          command: { data: { groups: [{ buckets: [{ remaining_fraction: 0.5 }] }] } },
        }),
        "2026-11-15T00:00:00.000Z",
        { expectedCommand: "quota" },
      ),
    invalidShape,
  );
});

test("AGY quota probe prefers native /usage SUCCESS envelope, falls back on top-level status ERROR, sets AGY_CLI_DISABLE_AUTO_UPDATE=true, and shadows open/xdg-open on PATH", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-usage-")),
    fakeBin = path.join(root, "fake-bin"),
    traceFile = path.join(root, "trace.jsonl"),
    browserMarker = path.join(root, "browser-launched"),
    resetAt = "2026-11-22T06:00:00.000Z";
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(traceFile, "");
  // Install real launcher executables on fakeBin so we can prove PATH shadowing blocks them
  // even when an expired-login CLI ignores BROWSER="false" and invokes open / xdg-open directly.
  for (const launcher of ["open", "xdg-open"] as const) {
    if (process.platform === "win32") {
      writeFileSync(path.join(fakeBin, `${launcher}.cmd`), `@echo ${launcher}>>"${browserMarker}"\r\n@exit /b 0\r\n`);
    } else {
      const target = path.join(fakeBin, launcher);
      writeFileSync(target, `#!/bin/sh\necho ${launcher} >> ${JSON.stringify(browserMarker)}\nexit 0\n`, {
        mode: 0o755,
      });
      chmodSync(target, 0o755);
    }
  }
  // Positive control: unguarded PATH executes fakeBin/open and writes browserMarker.
  const positiveControl = spawnSync(process.platform === "win32" ? "open.cmd" : "open", ["https://example.invalid"], {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
    shell: process.platform === "win32",
  });
  assert.equal(positiveControl.status, 0);
  assert.match(readFileSync(browserMarker, "utf8"), /open/u);
  rmSync(browserMarker, { force: true });

  const agyUsage = writeProviderExecutable(
    path.join(root, "agy-usage"),
    `
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
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
        // Deliberately ignore BROWSER="false" and try to launch OS browser via PATH.
        spawnSync(process.platform === "win32" ? "open.cmd" : "open", ["https://accounts.google.com/o/oauth2/auth"], {
          env: process.env,
          shell: process.platform === "win32",
        });
        spawnSync(process.platform === "win32" ? "xdg-open.cmd" : "xdg-open", ["https://accounts.google.com/o/oauth2/auth"], {
          env: process.env,
          shell: process.platform === "win32",
        });
        console.log(JSON.stringify({ status: "ERROR", command: { name: args[1].slice(1), error: "login expired" } }));
        process.exit(1);
      }
      if (process.env.USAGE_ERROR_ENVELOPE === "1") {
        if (args[1] === "/usage") {
          // Exit 0 with top-level status: "ERROR" EVEN WITH buckets present must NOT be accepted.
          console.log(JSON.stringify({
            status: "ERROR",
            command: {
              name: "usage",
              data: {
                plan: "Stale",
                groups: [{ group_id: "gemini", buckets: [{ bucket_id: "stale", remaining_fraction: 0.99 }] }]
              }
            }
          }));
          process.exit(0);
        }
        if (args[1] === "/quota") {
          console.log(JSON.stringify({
            status: "SUCCESS",
            command: {
              name: "quota",
              data: {
                plan: "Pro",
                groups: [{ group_id: "gemini", buckets: [{ bucket_id: "fallback-quota", remaining_fraction: 0.25, reset_time: ${JSON.stringify(resetAt)} }] }]
              }
            }
          }));
          process.exit(0);
        }
      }
      if (args[1] === "/usage") {
        console.log(JSON.stringify({
          status: "SUCCESS",
          command: {
            name: "usage",
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
    const baseEnv = { HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` };
    const quota = await probe.probeQuota({
      kindId: "agy",
      credentialSource: "instance",
      executablePath: agyUsage,
      env: baseEnv,
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
    assert.equal(events[0]?.noAutoUpdate, "true");
    assert.equal(events[0]?.noUpdateNotifier, "1");
    assert.equal(events[0]?.ssh, true);

    // Top-level /usage status: "ERROR" (even exit 0 with buckets) rejects and falls back cleanly to /quota.
    const fallbackQuota = await probe.probeQuota({
      kindId: "agy",
      credentialSource: "instance",
      executablePath: agyUsage,
      env: { ...baseEnv, USAGE_ERROR_ENVELOPE: "1" },
      now: () => "2026-11-21T10:00:00.000Z",
    });
    assert.ok(fallbackQuota);
    assert.equal(fallbackQuota.windows[0]?.id, "fallback-quota");
    assert.equal(fallbackQuota.windows[0]?.remainingFraction, 0.25);

    // Expired login attempting direct open/xdg-open fails closed without invoking fakeBin launchers.
    await assert.rejects(
      probe.probeQuota({
        kindId: "agy",
        credentialSource: "instance",
        executablePath: agyUsage,
        env: { ...baseEnv, EXPIRED_LOGIN: "1" },
        now: () => "2026-11-21T10:00:00.000Z",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_quota_probe_failed",
    );
    assert.throws(() => readFileSync(browserMarker, "utf8"), /ENOENT/u);
  } finally {
    removeTempRepository(root);
  }
});
