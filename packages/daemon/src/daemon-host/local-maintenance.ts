import { opendirSync, type Dirent } from "node:fs";
import { consumeKnownError } from "@harness-anything/kernel";

export type MaintenanceSchedule = (work: () => void) => void | Promise<void>;
type MaintenanceStep = void | "turn";

/** The directory cursor advances once per entry. A null read marks exhaustion. */
export function* directoryEntries(directory: string): Generator<Dirent> {
  const handle = opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) yield entry;
  } finally {
    handle.closeSync();
  }
}

/** A yielded step charges one filesystem item or one bounded projection page. */
export function scheduleMaintenance(
  schedule: MaintenanceSchedule,
  steps: Generator<MaintenanceStep>,
  batchSize: number,
  onComplete?: () => void,
): void {
  const enqueue = (): void => {
    let started = false;
    const scheduled = schedule(() => {
      started = true;
      for (let index = 0; index < batchSize; index += 1) {
        const step = steps.next();
        if (step.done) {
          onComplete?.();
          return;
        }
        if (step.value === "turn") break;
      }
      enqueue();
    });
    // A closed repository resolves its queued turn without running the callback.
    if (!(scheduled instanceof Promise)) return;
    void scheduled.then(
      () => {
        if (!started) steps.return(undefined);
      },
      (error: unknown) => {
        steps.return(undefined);
        consumeKnownError(error);
      },
    );
  };
  enqueue();
}
