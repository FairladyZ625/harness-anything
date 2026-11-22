/** Host-only filesystem capabilities declared under dec_89D06D7360CBEC09795F7B12EC/CH4. */
export const hostEnvironmentFiles = Object.freeze({
  fleetSnapshotPin: { name: "pin.json", owner: "packages/daemon/src/daemon-host/fleet/center-listener.ts" },
  fleetSnapshotTransfer: { name: "transfer.json", owner: "packages/daemon/src/daemon-host/fleet/walreceiver.ts" },
  modelPricingCache: {
    name: "model-pricing-cache.json",
    owner: "packages/daemon/src/daemon-host/model-pricing-refresh.ts",
  },
  worktreeSetupProgress: { name: "succeeded.json", owner: "packages/daemon/src/daemon-host/worktree-setup.ts" },
});

export const hostScratchPrefixes = Object.freeze({
  completionWitness: "ha-witness-code-",
  migrationOracle: "ha-migration-oracle-",
  migrationPlanning: "harness-migration-stage-",
  providerProbeHome: "ha-probe-home-",
});

export const hostEnvironmentIoModule = "packages/daemon/src/daemon-host/host-environment-io.ts";
const workspaceLockModule = "packages/daemon/src/daemon-host/repo-cell-lock.ts";

interface HostEnvironmentIoPort {
  readonly module: string;
  readonly scope: string;
  readonly effects: readonly string[];
  readonly stateStore?: string;
}

export const hostEnvironmentIoPorts: readonly HostEnvironmentIoPort[] = Object.freeze([
  {
    module: hostEnvironmentIoModule,
    scope: "writeHostEnvironmentFile",
    effects: ["open", "writeFile", "rename", "rm"],
  },
  {
    module: hostEnvironmentIoModule,
    scope: "openCallerOutputLineWriter",
    effects: ["mkdir", "open", "rename", "rm"],
  },
  {
    module: hostEnvironmentIoModule,
    scope: "writeCallerOutputFile",
    effects: ["mkdir", "open", "writeFile", "rename", "rm"],
  },
  { module: hostEnvironmentIoModule, scope: "createHostScratchDirectory", effects: ["rmSync"] },
  {
    module: workspaceLockModule,
    scope: "openWriterLockFile",
    effects: ["openSync"],
    stateStore: "execution.workspace-writer-lock",
  },
  {
    module: workspaceLockModule,
    scope: "acquireWorkspaceLock",
    effects: ["unlinkSync", "writeFileSync"],
    stateStore: "execution.workspace-writer-lock",
  },
  {
    module: workspaceLockModule,
    scope: "releaseWriterLockFile",
    effects: ["closeSync", "rmSync"],
    stateStore: "execution.workspace-writer-lock",
  },
]);
