import {
  type ActiveSnapshot,
  type RemoteReadDownBackoff,
  type ResumeCursor
} from "./remote-read-down-contract.ts";
import {
  asRemoteReadDownError,
  classifyRemoteReadDownFailure
} from "./remote-read-down-failure.ts";
import { advanceRemoteReadDownBackoff } from "./remote-read-down-state.ts";

export async function recoverRemoteSnapshot(input: {
  readonly resume: ResumeCursor | undefined;
  readonly backoff: RemoteReadDownBackoff;
  readonly connect: (replace: boolean) => Promise<void>;
  readonly openSnapshot: (resume: ResumeCursor | undefined) => Promise<ActiveSnapshot>;
  readonly assertCurrent: () => void;
  readonly stopped: () => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly terminal: (error: unknown) => Error;
  readonly diagnostic: ((text: string) => void) | undefined;
}): Promise<ActiveSnapshot> {
  let delay = input.backoff.initialMs;
  let replaceConnection = input.resume !== undefined;
  for (;;) {
    try {
      await input.connect(replaceConnection);
      input.assertCurrent();
    } catch (error) {
      if (input.stopped()) throw asRemoteReadDownError(error);
      if (classifyRemoteReadDownFailure(error) === "TERMINAL") {
        throw input.terminal(error);
      }
      await retry(input, error, delay);
      delay = advanceRemoteReadDownBackoff(delay, input.backoff);
      replaceConnection = true;
      continue;
    }
    try {
      const active = await input.openSnapshot(input.resume);
      input.assertCurrent();
      return active;
    } catch (error) {
      if (input.stopped()) throw asRemoteReadDownError(error);
      if (classifyRemoteReadDownFailure(error) === "TERMINAL") {
        throw input.terminal(error);
      }
      await retry(input, error, delay);
      delay = advanceRemoteReadDownBackoff(delay, input.backoff);
      replaceConnection = true;
    }
  }
}

async function retry(
  input: {
    readonly diagnostic: ((text: string) => void) | undefined;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly assertCurrent: () => void;
  },
  error: unknown,
  delay: number
): Promise<void> {
  input.diagnostic?.(
    `remote read-down reconnect failed; retrying in ${delay}ms: ${asRemoteReadDownError(error).message}`
  );
  await input.sleep(delay);
  input.assertCurrent();
}
