// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGuiE2E } from "../gui-e2e.mjs";
import { resolveProfileBaseDir, runScenario } from "./driver.mjs";
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
          async resetForScenario(nextRoot) {
            if (!alive) throw new Error("crashed");
            if (resetErrors.length > 0) {
              const nextError = resetErrors.shift();
              throw nextError;
            }
            resets.push({ driverId: `driver-${dId}`, nextRoot });
            this.runRoot = nextRoot;
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

  // If reset itself fails (e.g. console.error/pageerror during reload), the error is NOT swallowed:
  // the pool discards the dirty driver and throws so the acquiring scenario fails, while the next
  // scenario recovers with a fresh driver.
  fake.queueResetError(new Error("renderer console errors:\nsynthetic_reset_error"));
  await assert.rejects(() => pool.acquire({ id: "s2b", readOnly: true }, "/tmp/run/s2b"), /synthetic_reset_error/u);

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
