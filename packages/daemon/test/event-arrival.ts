/**
 * Wait until a durable read reports a value, without losing an arrival between the read and the
 * subscription. Order is the contract: `subscribe` installs the wake-up first, then `read` observes
 * durable state. An arrival that lands before or during the read is therefore either seen by the
 * read itself or delivered to the already-installed wake-up; a caller that reads first and
 * subscribes afterwards has a window in which the only notification is discarded.
 */
export async function waitForArrival<T>(
  read: () => T | null,
  subscribe: (arrive: () => void) => () => void,
): Promise<T> {
  for (;;) {
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unsubscribe = subscribe(release);
    try {
      const value = read();
      if (value !== null) return value;
      await arrived;
    } finally {
      unsubscribe();
    }
  }
}
