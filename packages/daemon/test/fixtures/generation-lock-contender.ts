import { existsSync, writeFileSync } from "node:fs";
import {
  createDaemonGenerationWitness,
  daemonGenerationRecordPath,
  recoverAbandonedDaemonGenerationMutationLock
} from "../../src/lifecycle/daemon-generation.ts";

const [root, endpointIdentity, machineId, generationText, markerPath, releasePath, contenderId] = process.argv.slice(2);
if (!root || !endpointIdentity || !machineId || !generationText || !markerPath || !releasePath || !contenderId) {
  throw new Error("generation lock contender arguments are required");
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const lockPath = `${daemonGenerationRecordPath(root, endpointIdentity)}.lock`;
recoverAbandonedDaemonGenerationMutationLock(lockPath, () => {
  writeFileSync(markerPath, contenderId, "utf8");
  while (!existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 5);
});

const witness = createDaemonGenerationWitness({
  userRoot: root,
  endpointIdentity,
  machineId,
  daemonGeneration: Number(generationText)
});

await witness.runExclusive(async () => {
  process.send?.({ type: "acquired", contenderId });
  await new Promise<void>((resolve) => process.once("message", (message) => {
    if (message === "release") resolve();
  }));
});
process.send?.({ type: "done", contenderId });
process.disconnect?.();
