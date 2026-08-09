import type { AsyncLocalStorage } from "node:async_hooks";

export interface DaemonGenerationLockContext {
  readonly heldLocks: ReadonlyMap<string, string>;
  active: boolean;
}

interface SharedDaemonGenerationMutationLock {
  readonly context: DaemonGenerationLockContext;
  readonly joined: Set<Promise<unknown>>;
  readonly released: Promise<void>;
  readonly release: () => void;
  readonly sharingToken: Promise<void>;
  accepting: boolean;
}

const sharedLocks = new Map<string, SharedDaemonGenerationMutationLock>();

export async function runWithSharedDaemonGenerationLock<Result>(input: {
  readonly lockPath: string;
  readonly storage: AsyncLocalStorage<DaemonGenerationLockContext>;
  readonly sharingToken?: Promise<void>;
  readonly acquire: () => string;
  readonly release: (ownerToken: string) => void;
  readonly operation: () => Promise<Result>;
}): Promise<Result> {
  const parent = input.storage.getStore();
  if (parent?.active && parent.heldLocks.has(input.lockPath)) return input.operation();
  const shared = sharedLocks.get(input.lockPath);
  if (input.sharingToken && shared?.sharingToken === input.sharingToken
    && shared.accepting && shared.context.active) {
    return joinSharedLock(shared, input.storage, input.operation);
  }
  if (shared) {
    await shared.released;
    return runWithSharedDaemonGenerationLock(input);
  }

  const ownerToken = input.acquire();
  const context: DaemonGenerationLockContext = {
    heldLocks: new Map([
      ...(parent?.active ? parent.heldLocks : []),
      [input.lockPath, ownerToken] as const
    ]),
    active: true
  };
  let signalReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    signalReleased = resolve;
  });
  const owned: SharedDaemonGenerationMutationLock | undefined = input.sharingToken
    ? {
      context,
      joined: new Set(),
      released,
      release: signalReleased,
      sharingToken: input.sharingToken,
      accepting: true
    }
    : undefined;
  if (owned) sharedLocks.set(input.lockPath, owned);

  let result: Result | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await input.storage.run(context, input.operation);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  while (owned && owned.joined.size > 0) await Promise.allSettled([...owned.joined]);
  if (owned) {
    owned.accepting = false;
    sharedLocks.delete(input.lockPath);
  }
  context.active = false;
  if (operationFailed) {
    try {
      input.release(ownerToken);
    } catch {
      // The operation failure is authoritative; cleanup must never replace it.
    } finally {
      owned?.release();
    }
    throw operationError;
  }
  try {
    input.release(ownerToken);
  } finally {
    owned?.release();
  }
  return result as Result;
}

function joinSharedLock<Result>(
  shared: SharedDaemonGenerationMutationLock,
  storage: AsyncLocalStorage<DaemonGenerationLockContext>,
  operation: () => Promise<Result>
): Promise<Result> {
  let joined: Promise<Result>;
  try {
    joined = Promise.resolve(storage.run(shared.context, operation));
  } catch (error) {
    return Promise.reject(error);
  }
  shared.joined.add(joined);
  void joined.then(
    () => shared.joined.delete(joined),
    () => shared.joined.delete(joined)
  );
  return joined;
}
