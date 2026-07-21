import { existsSync, readFileSync } from "node:fs";
import * as daemon from "../packages/daemon/src/index.ts";
import * as kernel from "../packages/kernel/src/index.ts";

const supportPath = "packages/kernel/src/daemon-runtime-support.ts";
const storeBarrelPath = "packages/kernel/src/store/index.ts";
const expectedSupportExports = [
  "DaemonAdmissionBudgetSnapshot",
  "DaemonAdmissionReservation",
  "DaemonGlobalLock",
  "DaemonQueueDrainTarget",
  "EnsureExecutionEvidenceGenerationResult",
  "ExecutionEvidencePage",
  "ExecutionEvidencePageQuery",
  "ProjectionChangeEvent",
  "ProjectionGenerationChangedError",
  "ProjectionSourceFenceFactory",
  "ReadyProjectionGeneration",
  "StableProjectionSourceFence",
  "WriteIntegrityDomain",
  "acquireDaemonGlobalLock",
  "assertDaemonGlobalLockHeld",
  "createProjectionChangePublisher",
  "createRuntimeAdmissionBudget",
  "ensureExecutionEvidenceGenerationReady",
  "queryExecutionEvidencePageFromReadyGeneration",
  "recoverJournaledWrites",
  "singleWriteIntegrityDomain",
  "updateExecutionEvidenceProjectionIncrementally",
  "writeOpTouchedPaths"
].sort();

const supportSource = readFileSync(supportPath, "utf8");
const supportHasCatchAll = /\bexport\s+(?:type\s+)?\*/u.test(supportSource);
const supportExports = [...supportSource.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']+["']/gsu)]
  .flatMap((match) => match[1].split(","))
  .map((entry) => entry.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u).at(-1)?.trim() ?? "")
  .filter(Boolean)
  .sort();

const result = {
  daemonOwnsRuntime: typeof daemon.createDaemonRuntime === "function"
    && typeof daemon.createMultiRepoDaemonRuntime === "function",
  kernelRootOwnsRuntime: typeof kernel.createDaemonRuntime === "function"
    || typeof kernel.createMultiRepoDaemonRuntime === "function",
  kernelStoreBarrelExists: existsSync(storeBarrelPath),
  supportHasCatchAll,
  supportExportsExact: JSON.stringify(supportExports) === JSON.stringify(expectedSupportExports)
};

console.log(JSON.stringify(result));
process.exit(
  result.daemonOwnsRuntime
  && !result.kernelRootOwnsRuntime
  && !result.kernelStoreBarrelExists
  && !result.supportHasCatchAll
  && result.supportExportsExact
    ? 0
    : 1
);
