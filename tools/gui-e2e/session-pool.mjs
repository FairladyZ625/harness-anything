import { withTimeout } from "./driver.mjs";
import { openIsolatedFixture, openLane } from "./lanes.mjs";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;

/**
 * Determine whether a scenario can safely reuse a lane-scoped shared session.
 * Write-state scenarios and custom-fixture scenarios stay isolated in their own
 * disposable daemon/repo directory.
 */
export function isShareableReadOnlyScenario(scenario, lane) {
  if (lane === "canonical") return scenario.readOnly !== false;
  if (lane === "isolated") {
    return (
      scenario.readOnly === true &&
      !scenario.runtimeInstance &&
      !scenario.identityProvider &&
      scenario.id !== "sessions-delivery-status"
    );
  }
  return false;
}

/**
 * Manage lane-level session reuse for read-only GUI E2E scenarios while keeping
 * write-state scenarios strictly isolated. Both canonical and isolated lanes share
 * a hermetic preflighted fixture daemon and built Electron bundle. Any failure,
 * timeout, or renderer crash destroys the dirty Electron instance (and recreates
 * the fixture daemon if unhealthy) so one bad scenario never cascades.
 */
export function createLaneSessionPool({
  lane,
  workspaceRoot,
  env,
  startDriver,
  openLaneImpl = openLane,
  openIsolatedFixtureImpl = openIsolatedFixture,
  acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
}) {
  let sharedFixture = null;
  let sharedDriver = null;

  async function discardSharedDriver() {
    const driver = sharedDriver;
    sharedDriver = null;
    if (driver) {
      await withTimeout(driver.close(), cleanupTimeoutMs, "Timed out closing shared Electron driver").catch(
        () => undefined,
      );
    }
  }

  async function discardSharedAll() {
    await discardSharedDriver();
    const fixture = sharedFixture;
    sharedFixture = null;
    if (fixture) {
      await withTimeout(fixture.close(), cleanupTimeoutMs, "Timed out closing shared fixture daemon").catch(
        () => undefined,
      );
    }
  }

  async function acquireShared(scenarioRoot) {
    if (sharedFixture && !(await sharedFixture.isHealthy())) {
      await discardSharedAll();
    }
    if (sharedDriver) {
      const alive = typeof sharedDriver.isAlive === "function" ? sharedDriver.isAlive() : true;
      if (alive) {
        const driver = sharedDriver;
        driver.runRoot = scenarioRoot;
        return { driver, prepare: () => driver.resetForScenario() };
      }
      await discardSharedDriver();
    }
    if (!sharedFixture) {
      const fixturePromise = openIsolatedFixtureImpl({
        workspaceRoot,
        scenarioId: "shared-readonly",
        env,
      });
      fixturePromise.catch(() => undefined);
      try {
        sharedFixture = await withTimeout(
          fixturePromise,
          acquireTimeoutMs,
          `Timed out starting shared ${lane} fixture daemon`,
        );
      } catch (error) {
        // Close a late-starting daemon if acquisition timed out so it cannot leak open handles.
        void fixturePromise.then((fixture) => fixture?.close?.().catch(() => undefined)).catch(() => undefined);
        throw error;
      }
    }
    const driverPromise = sharedFixture.launchDriver({ runRoot: scenarioRoot, startDriver });
    driverPromise.catch(() => undefined);
    try {
      sharedDriver = await withTimeout(
        driverPromise,
        acquireTimeoutMs,
        `Timed out launching shared ${lane} Electron driver`,
      );
      return { driver: sharedDriver };
    } catch (error) {
      void driverPromise.then((driver) => driver?.close?.().catch(() => undefined)).catch(() => undefined);
      await discardSharedAll();
      throw error;
    }
  }

  return {
    async acquire(scenario, scenarioRoot) {
      if (!isShareableReadOnlyScenario(scenario, lane)) {
        const opening = openLaneImpl({
          lane,
          scenarioId: scenario.id,
          workspaceRoot,
          env,
          runRoot: scenarioRoot,
          startDriver,
          runtimeInstance: scenario.runtimeInstance,
          identityProvider: scenario.identityProvider,
          decisionProviderCredentials: scenario.decisionProviderCredentials,
        });
        let active;
        try {
          active = await withTimeout(
            opening,
            acquireTimeoutMs,
            `Timed out acquiring dedicated session for ${scenario.id}`,
          );
        } catch (error) {
          // A timed-out acquisition no longer has a lease to close a late session.
          void opening.then((late) => late.close()).catch(() => undefined);
          throw error;
        }
        return {
          driver: active.driver,
          shared: false,
          async release({ outcome } = {}) {
            const alive = typeof active.driver?.isAlive === "function" ? active.driver.isAlive() : true;
            await withTimeout(
              active.close(),
              cleanupTimeoutMs,
              `Timed out closing dedicated session for ${scenario.id}`,
            );
            if (outcome !== "failed" && !alive) {
              throw new Error(`Electron renderer/session died before release in ${scenario.id}`);
            }
          },
        };
      }

      const { driver, prepare } = await acquireShared(scenarioRoot);

      return {
        driver,
        prepare,
        shared: true,
        async release({ outcome } = {}) {
          const alive = typeof driver.isAlive === "function" ? driver.isAlive() : true;
          if (outcome === "failed" || !alive) {
            await discardSharedDriver();
          }
          if (outcome !== "failed" && !alive) {
            throw new Error(`Electron renderer/session died before release in ${scenario.id}`);
          }
        },
      };
    },

    async close() {
      await discardSharedAll();
    },
  };
}
