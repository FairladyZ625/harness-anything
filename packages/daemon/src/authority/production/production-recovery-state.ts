import { recoveryErrorSummary } from "./recovery.ts";

export interface ProductionRecoveryState {
  status: "recovering" | "complete" | "failed";
  error?: string;
  promise: Promise<void>;
}

export async function settleProductionRecovery(
  recovery: ProductionRecoveryState,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
    recovery.status = "complete";
    recovery.error = undefined;
  } catch (error) {
    recovery.status = "failed";
    recovery.error = recoveryErrorSummary(error);
  }
}
