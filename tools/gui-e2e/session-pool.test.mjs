// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";
import { runGuiE2E } from "../gui-e2e.mjs";
import { assessHermeticConfig } from "../test-hermetic-preflight.mjs";
import { resolveProfileBaseDir, runScenario } from "./driver.mjs";
import { openLane } from "./lanes.mjs";
import { createLaneSessionPool, isShareableReadOnlyScenario } from "./session-pool.mjs";

function makeFakeEnv() {
  let fixtureSeq = 0;
  let driverSeq = 0;
  let isolatedOpenCount = 0;
  const closedFixtures = [];
  const closedDrivers = [];
  const resets = [];
  const unhealthyFixtures = new Set();
  const resetErrors = [];

  const openIsolatedFixtureImpl = async () => {
    fixtureSeq += 1;
    const fId = fixtureSeq;
    return {
      fixture: { id: `fixture-${fId}`, endpoint: `unix://fake-${fId}`, rootDir: `/tmp/fake-${fId}` },
      async isHealthy() {
        return !unhealthyFixtures.has(`fixture-${fId}`);
      },
      async launchDriver({ runRoot }) {
        driverSeq += 1;
        const dId = driverSeq;
        let alive = true;
        return {
          id: `driver-${dId}`,
          runRoot,
          consoleCursor: 0,
          consoleFailures: [],
          isAlive: () => alive,
          kill() {
            alive = false;
          },
          async resetForScenario() {
            if (!alive) throw new Error("crashed");
            if (resetErrors.length > 0) {
              const nextError = resetErrors.shift();
              throw nextError;
            }
            resets.push({ driverId: `driver-${dId}`, nextRoot: this.runRoot });
          },
          async close() {
            alive = false;
            closedDrivers.push(`driver-${dId}`);
          },
        };
      },
      async close() {
        closedFixtures.push(`fixture-${fId}`);
      },
    };
  };

  const openLaneImpl = async ({ scenarioId, runRoot }) => {
    isolatedOpenCount += 1;
    const tag = `dedicated-${scenarioId}-${isolatedOpenCount}`;
    return {
      driver: { id: tag, runRoot, consoleCursor: 0, consoleFailures: [], isAlive: () => true },
      async close() {
        closedDrivers.push(tag);
      },
    };
  };

  return {
    openIsolatedFixtureImpl,
    openLaneImpl,
    markFixtureUnhealthy: (id) => {
      unhealthyFixtures.add(id);
    },
    queueResetError: (error) => {
      resetErrors.push(error);
    },
    stats: () => ({
      fixtureSeq,
      driverSeq,
      isolatedOpenCount,
      closedFixtures,
      closedDrivers,
      resets,
    }),
  };
}

test("isShareableReadOnlyScenario keeps write-state and custom-fixture scenarios isolated", () => {
  assert.equal(isShareableReadOnlyScenario({ id: "a", readOnly: true }, "isolated"), true);
  assert.equal(isShareableReadOnlyScenario({ id: "b" }, "isolated"), false);
  assert.equal(isShareableReadOnlyScenario({ id: "c", readOnly: true, runtimeInstance: {} }, "isolated"), false);
  assert.equal(
    isShareableReadOnlyScenario({ id: "d", readOnly: true, identityProvider: "builtin" }, "isolated"),
    false,
  );
  assert.equal(isShareableReadOnlyScenario({ id: "sessions-delivery-status", readOnly: true }, "isolated"), false);
  assert.equal(isShareableReadOnlyScenario({ id: "shell-navigation", readOnly: true }, "canonical"), true);
  assert.equal(isShareableReadOnlyScenario({ id: "mut", readOnly: false }, "canonical"), false);
});

test("a rejected temporary user root never starts the fixture daemon", async () => {
  let starts = 0;
  let userRoot;
  await assert.rejects(async () => {
    const fixture = await startGuiResidentDaemonFixture({
      assessConfig(config) {
        userRoot = config.userRoot;
        // Simulate the newly allocated path resolving to the same directory as the account root.
        return assessHermeticConfig({ ...config, readIdentity: () => ({ dev: 1, ino: 2 }) });
      },
      start() {
        starts += 1;
        throw new Error("unexpected daemon start");
      },
    });
    await fixture.stop();
  }, /Hermetic fixture preflight failed:.*is the default daemon root/u);
  assert.equal(starts, 0);
  assert.throws(() => readFileSync(path.dirname(userRoot)), { code: "ENOENT" });
});

test("dedicated lane closes the daemon even if Electron close rejects", async () => {
  let fixtureCloses = 0;
  const lane = await openLane(
    {},
    {
      openFixture: async () => ({
        launchDriver: async () => ({
          async close() {
            throw new Error("driver_close_probe");
          },
        }),
        async close() {
          fixtureCloses += 1;
        },
      }),
    },
  );
  await assert.rejects(() => lane.close(), /driver_close_probe/u);
  assert.equal(fixtureCloses, 1);
});

test("dedicated acquire timeout closes a session that finishes opening later", async (t) => {
  const opened = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const keepAlive = new AbortController();
  t.after(() => keepAlive.abort());
  // The production deadline is unref'd. Hold the test process open until the deadline settles.
  void setTimeout(5_000, undefined, { signal: keepAlive.signal }).catch(() => undefined);
  const pool = createLaneSessionPool({
    lane: "isolated",
    acquireTimeoutMs: 5,
    openLaneImpl: () => opened.promise,
  });
  t.after(() => pool.close());
  await assert.rejects(pool.acquire({ id: "write" }, "/tmp/run/write"), /Timed out acquiring dedicated session/u);
  let closes = 0;
  opened.resolve({
    async close() {
      closes += 1;
      closed.resolve();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  await closed.promise;
});

test("interleaved dedicated fixtures keep ambient execution credentials suppressed until the last fixture stops", async (t) => {
  const sockDir = mkdtempSync(path.join(tmpdir(), "gui-interleaved-sock-"));
  const priorCredential = process.env.HARNESS_EXECUTION_CREDENTIAL;
  process.env.HARNESS_EXECUTION_CREDENTIAL = "ambient-worker-credential";
  t.after(() => {
    rmSync(sockDir, { recursive: true, force: true });
    if (priorCredential === undefined) delete process.env.HARNESS_EXECUTION_CREDENTIAL;
    else process.env.HARNESS_EXECUTION_CREDENTIAL = priorCredential;
  });

  const observedHelloCredentials = [];
  const serveMockBootstrap = async (index) => {
    const sockPath = path.join(sockDir, `d-${index}.sock`);
    const server = net.createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          if (req.method === "protocol.hello") {
            observedHelloCredentials.push({ index, cred: req.params?.executionCredential });
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true, protocolVersion: req.params?.protocolVersion, methods: ["daemon.repo.bootstrap"] } })}\n`,
            );
          } else if (req.method === "daemon.repo.bootstrap") {
            const leaked = observedHelloCredentials.find((x) => x.index === index && x.cred !== undefined);
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: leaked ? { ok: false, code: "execution_credential_rejected" } : { ok: true } })}\n`,
            );
          }
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    return {
      endpoint: sockPath,
      async stop() {
        await new Promise((resolve) => server.close(() => resolve()));
      },
    };
  };

  const firstReady = Promise.withResolvers();
  const lateOpenGate = Promise.withResolvers();
  const lateClosed = Promise.withResolvers();
  let callIndex = 0;
  const pool = createLaneSessionPool({
    lane: "isolated",
    acquireTimeoutMs: 1_500,
    openLaneImpl: async () => {
      const currentCall = ++callIndex;
      const fixture = await startGuiResidentDaemonFixture({
        identityProvider: "builtin",
        start: async () => {
          const started = await serveMockBootstrap(currentCall);
          if (currentCall === 2) {
            // Force the timed-out first session to finish opening and close right before
            // the second fixture performs its daemon.repo.bootstrap RPC handshake.
            await firstReady.promise;
            lateOpenGate.resolve();
            await lateClosed.promise;
          }
          return started;
        },
      });
      assert.equal(process.env.HARNESS_EXECUTION_CREDENTIAL, undefined);
      if (currentCall === 1) {
        firstReady.resolve();
        await lateOpenGate.promise;
      }
      return {
        driver: { isAlive: () => true },
        async close() {
          await fixture.stop();
          if (currentCall === 1) lateClosed.resolve();
        },
      };
    },
  });

  await assert.rejects(
    pool.acquire({ id: "timed-out-write" }, "/tmp/run/s1"),
    /Timed out acquiring dedicated session/u,
  );
  const secondLease = await pool.acquire({ id: "next-write" }, "/tmp/run/s2");
  assert.equal(process.env.HARNESS_EXECUTION_CREDENTIAL, undefined);
  assert.deepEqual(observedHelloCredentials, [
    { index: 1, cred: undefined },
    { index: 2, cred: undefined },
  ]);

  await secondLease.release({ outcome: "healthy" });
  await pool.close();
  assert.equal(process.env.HARNESS_EXECUTION_CREDENTIAL, "ambient-worker-credential");
});

test("shared pool rebuilds a dead fixture before resetting a still-live Electron", async (t) => {
  const fake = makeFakeEnv();
  const pool = createLaneSessionPool({ lane: "isolated", ...fake });
  t.after(() => pool.close());
  const first = await pool.acquire({ id: "s1", readOnly: true }, "/tmp/run/s1");
  await first.release({ outcome: "healthy" });
  fake.markFixtureUnhealthy("fixture-1");
  assert.equal(first.driver.isAlive(), true);

  const next = await pool.acquire({ id: "s2", readOnly: true }, "/tmp/run/s2");
  await next.release({ outcome: "healthy" });
  assert.equal(next.driver.id, "driver-2");
  assert.deepEqual(fake.stats().closedDrivers, ["driver-1"]);
  assert.deepEqual(fake.stats().closedFixtures, ["fixture-1"]);
  assert.deepEqual(fake.stats().resets, []);
});

test("isolated and canonical pools reuse one hermetic fixture and Electron driver across healthy read-only scenarios", async () => {
  for (const lane of ["isolated", "canonical"]) {
    const fake = makeFakeEnv();
    const pool = createLaneSessionPool({
      lane,
      workspaceRoot: "/tmp/repo",
      env: {},
      startDriver: async () => {
        throw new Error("unused");
      },
      ...fake,
    });

    const l1 = await pool.acquire({ id: "s1", readOnly: true }, "/tmp/run/s1");
    assert.equal(l1.shared, true);
    assert.equal(l1.driver.id, "driver-1");
    await l1.release({ outcome: "healthy" });

    const l2 = await pool.acquire({ id: "s2", readOnly: true }, "/tmp/run/s2");
    assert.equal(l2.shared, true);
    assert.equal(l2.driver.id, "driver-1");
    assert.equal(l2.driver.runRoot, "/tmp/run/s2");
    await l2.prepare();
    await l2.release({ outcome: "healthy" });

    // Write-state scenario gets its own isolated fixture & closes immediately.
    const l3 = await pool.acquire({ id: "task-rework", readOnly: false }, "/tmp/run/task-rework");
    assert.equal(l3.shared, false);
    assert.equal(l3.driver.id, "dedicated-task-rework-1");
    await l3.release({ outcome: "healthy" });

    await pool.close();
    const stats = fake.stats();
    assert.equal(stats.fixtureSeq, 1);
    assert.equal(stats.driverSeq, 1);
    assert.equal(stats.isolatedOpenCount, 1);
    assert.deepEqual(stats.resets, [{ driverId: "driver-1", nextRoot: "/tmp/run/s2" }]);
    assert.deepEqual(stats.closedDrivers, ["dedicated-task-rework-1", "driver-1"]);
    assert.deepEqual(stats.closedFixtures, ["fixture-1"]);
  }
});

test("shared pool destroys a failed or crashed Electron driver and recreates cleanly for the next scenario", async () => {
  const fake = makeFakeEnv();
  const pool = createLaneSessionPool({
    lane: "isolated",
    workspaceRoot: "/tmp/repo",
    env: {},
    startDriver: async () => {
      throw new Error("unused");
    },
    ...fake,
  });

  const l1 = await pool.acquire({ id: "s1", readOnly: true }, "/tmp/run/s1");
  l1.driver.kill();
  await assert.rejects(() => l1.release({ outcome: "healthy" }), /died before release/u);

  // Next scenario gets a brand-new Electron driver on the healthy shared fixture.
  const l2 = await pool.acquire({ id: "s2", readOnly: true }, "/tmp/run/s2");
  assert.equal(l2.driver.id, "driver-2");
  await l2.release({ outcome: "healthy" });

  // The runner can collect evidence before releasing a driver whose reset failed.
  fake.queueResetError(new Error("renderer console errors:\nsynthetic_reset_error"));
  const l2b = await pool.acquire({ id: "s2b", readOnly: true }, "/tmp/run/s2b");
  await assert.rejects(l2b.prepare, /synthetic_reset_error/u);
  assert.equal(l2b.driver.isAlive(), true);
  await l2b.release({ outcome: "failed" });

  const l2c = await pool.acquire({ id: "s2c", readOnly: true }, "/tmp/run/s2c");
  assert.equal(l2c.driver.id, "driver-3");
  await l2c.release({ outcome: "healthy" });

  // If the daemon itself became unhealthy, the pool rebuilds the fixture too.
  fake.markFixtureUnhealthy("fixture-1");
  l2c.driver.kill();
  await l2c.release({ outcome: "failed" });

  const l3 = await pool.acquire({ id: "s3", readOnly: true }, "/tmp/run/s3");
  assert.equal(l3.driver.id, "driver-4");
  await l3.release({ outcome: "healthy" });

  await pool.close();
  const stats = fake.stats();
  assert.equal(stats.fixtureSeq, 2);
  assert.equal(stats.driverSeq, 4);
  assert.deepEqual(stats.closedFixtures, ["fixture-1", "fixture-2"]);
});

test("runScenario attributes tracing.start failures to the scenario without throwing", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "gui-tracing-start-fail-"));
  try {
    const fakeDriver = {
      runRoot: outDir,
      consoleCursor: 0,
      consoleFailures: [],
      isAlive: () => true,
      async assertBackground() {},
      assertConsoleClean() {},
      markConsoleClean() {},
      async shot() {
        return null;
      },
      page: {
        context() {
          return {
            tracing: {
              async start() {
                throw new Error("tracing_start_boom");
              },
            },
          };
        },
      },
    };
    const res = await runScenario(
      fakeDriver,
      { id: "s-trace-fail", feature: "trace", lane: "isolated", run: async () => undefined },
      { shots: null, trace: true },
    );
    assert.equal(res.outcome, "failed");
    assert.equal(res.failedStep, "s-trace-fail");
    assert.match(res.message, /tracing_start_boom/u);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the final scenario fails on renderer errors delivered while screenshots or tracing stop finish and preserves trace ZIP", async (t) => {
  const outDir = mkdtempSync(path.join(tmpdir(), "gui-late-renderer-error-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const zipHeader = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
  for (const phase of ["screenshot", "trace-stop"]) {
    const phaseDir = path.join(outDir, phase);
    mkdirSync(phaseDir, { recursive: true });
    const consoleFailures = [];
    const driver = {
      runRoot: phaseDir,
      async assertBackground() {},
      assertConsoleClean(from) {
        assert.deepEqual(consoleFailures.slice(from), []);
      },
      async shot() {
        if (phase === "screenshot") consoleFailures.push("late_renderer_error");
        return null;
      },
      page: {
        context: () => ({
          tracing: {
            async start() {},
            async stop(options) {
              if (options?.path) writeFileSync(options.path, zipHeader);
              if (phase === "trace-stop") consoleFailures.push("late_renderer_error");
            },
          },
        }),
      },
    };
    const res = await runScenario(driver, { id: "last", run: async () => undefined }, { shots: phaseDir });
    assert.equal(res.outcome, "failed", phase);
    assert.match(res.message, /late_renderer_error/u);
    assert.equal(res.tracePath, path.join(phaseDir, "last-trace.zip"), phase);
    assert.equal(existsSync(res.tracePath), true, phase);
    assert.deepEqual(readFileSync(res.tracePath).subarray(0, 4), Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.deepEqual(
      readdirSync(phaseDir).filter((file) => file.endsWith(".zip")),
      ["last-trace.zip"],
    );
  }

  const healthyDir = path.join(outDir, "healthy");
  mkdirSync(healthyDir, { recursive: true });
  const healthyRes = await runScenario(
    {
      runRoot: healthyDir,
      async assertBackground() {},
      assertConsoleClean() {},
      async shot() {
        return null;
      },
      page: {
        context: () => ({
          tracing: {
            async start() {},
            async stop(options) {
              if (options?.path) writeFileSync(options.path, zipHeader);
            },
          },
        }),
      },
    },
    { id: "clean-last", run: async () => undefined },
    { shots: healthyDir },
  );
  assert.equal(healthyRes.outcome, "healthy");
  assert.equal(healthyRes.tracePath, undefined);
  assert.deepEqual(
    readdirSync(healthyDir).filter((file) => file.endsWith(".zip")),
    [],
  );
});

test("runGuiE2E converts acquire, release, and dead-renderer faults into per-scenario failures and writes result.json", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "gui-runner-faults-"));
  try {
    let acquireCalls = 0;
    const makeFakeDriver = ({ killOnRun = false } = {}) => {
      let alive = true;
      return {
        runRoot: outDir,
        consoleCursor: 0,
        consoleFailures: [],
        isAlive: () => alive,
        kill() {
          alive = false;
        },
        async assertBackground() {},
        assertConsoleClean() {},
        markConsoleClean() {},
        async shot() {
          return null;
        },
        killOnRun,
      };
    };

    const scenarios = [
      { id: "s-acquire-fail", feature: "f", lane: "isolated", readOnly: true, run: async () => undefined },
      {
        id: "s-dead-on-release",
        feature: "f",
        lane: "isolated",
        readOnly: true,
        run: async () => undefined,
      },
      { id: "s-survives", feature: "f", lane: "isolated", readOnly: true, run: async () => undefined },
    ];

    const { result, runRoot } = await runGuiE2E({
      lane: "isolated",
      noBuild: true,
      shots: outDir,
      trace: false,
      selectedScenarios: scenarios,
      createPool: () => ({
        async acquire(scenario) {
          acquireCalls += 1;
          if (scenario.id === "s-acquire-fail") {
            throw new Error("acquire_boom");
          }
          const driver = makeFakeDriver();
          return {
            driver,
            shared: true,
            async release({ outcome }) {
              if (scenario.id === "s-dead-on-release") {
                driver.kill();
                if (outcome !== "failed") throw new Error("dead_renderer_on_release");
              }
            },
          };
        },
        async close() {},
      }),
    });

    assert.equal(acquireCalls, 3);
    assert.equal(result.outcome, "failed");
    assert.equal(result.scenarios.length, 3);
    assert.equal(result.scenarios[0].id, "s-acquire-fail");
    assert.equal(result.scenarios[0].outcome, "failed");
    assert.match(result.scenarios[0].message, /acquire_boom/u);
    assert.equal(result.scenarios[1].id, "s-dead-on-release");
    assert.equal(result.scenarios[1].outcome, "failed");
    assert.match(result.scenarios[1].message, /dead_renderer_on_release/u);
    assert.equal(result.scenarios[2].id, "s-survives");
    assert.equal(result.scenarios[2].outcome, "healthy");

    const diskResult = JSON.parse(readFileSync(path.join(runRoot, "result.json"), "utf8"));
    assert.equal(diskResult.scenarios.length, 3);
    assert.equal(diskResult.scenarios[2].outcome, "healthy");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("resolveProfileBaseDir avoids Linux SingletonSocket sun_path overflow on deep temp dirs", () => {
  assert.equal(resolveProfileBaseDir({ platform: "linux", baseTmpDir: "/tmp" }), "/tmp");
  assert.equal(
    resolveProfileBaseDir({
      platform: "linux",
      baseTmpDir: "/tmp/colab-test-queue/slot-1/runs/.aux-run-harness-anything-1794991707494-7c67fb/tmp",
    }),
    "/tmp",
  );
  assert.equal(
    resolveProfileBaseDir({
      platform: "darwin",
      baseTmpDir: "/var/folders/very-long-sandbox-path/1234567890123456789012345678901234567890/T",
    }),
    "/var/folders/very-long-sandbox-path/1234567890123456789012345678901234567890/T",
  );
});
