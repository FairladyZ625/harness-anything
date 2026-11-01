import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
export const SQLITE_LEDGER_GENERATION = 3;
export function sqliteLedgerPath(input: HarnessLayoutInput, generation = SQLITE_LEDGER_GENERATION): string {
  return path.join(resolveHarnessLayout(input).localRoot, "store", "generations", String(generation), "ledger.sqlite");
}
