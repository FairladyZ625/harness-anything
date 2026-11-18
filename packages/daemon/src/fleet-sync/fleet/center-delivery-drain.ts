/** A claimed delivery owns preparation, sending, and the wait for ACK or release.
 * Releasing the lease alone cannot settle transport work still unwinding after disconnect. */
export function createFleetDeliveryDrain(onSettled?: () => void) {
  const pending = new Set<() => void>();
  return {
    pending: () => pending.size,
    admit: () => {
      let preparing = true;
      let sending = true;
      let released = false;
      const settle = () => {
        if (!preparing && !sending && released && pending.delete(settle)) onSettled?.();
      };
      pending.add(settle);
      return {
        preparationFinished: () => {
          preparing = false;
          settle();
        },
        sendingFinished: () => {
          sending = false;
          settle();
        },
        released: () => {
          released = true;
          settle();
        },
      };
    },
  };
}
