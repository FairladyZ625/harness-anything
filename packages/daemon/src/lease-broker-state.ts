import { existsSync, readFileSync } from "node:fs";
import { writeFileDurably } from "./durable-file.ts";
import type { BrokerReceipts, BrokerState } from "./lease-broker.ts";

function readBrokerFile(file: string): Record<string, unknown> | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
}

export function loadBrokerState(file: string): BrokerState {
  const value = readBrokerFile(file);
  if (!value) return { seq: 0, leases: {}, queue: {} };
  if (
    value.schema !== "fleet-lease-state/v1" ||
    typeof value.seq !== "number" ||
    value.leases === null ||
    typeof value.leases !== "object" ||
    value.queue === null ||
    typeof value.queue !== "object"
  )
    throw new Error("Fleet lease broker state contains an unrecognized shape");
  return { seq: value.seq, leases: value.leases, queue: value.queue } as BrokerState;
}

export function loadBrokerReceipts(file: string): BrokerReceipts {
  const value = readBrokerFile(file);
  if (!value) return {};
  if (value.schema !== "fleet-lease-state/v1" || value.receipts === null || typeof value.receipts !== "object")
    throw new Error("Fleet lease broker receipts contain an unrecognized shape");
  return value.receipts as BrokerReceipts;
}

export function writeBrokerFile(file: string, value: object): void {
  writeFileDurably(file, `${JSON.stringify({ schema: "fleet-lease-state/v1", ...value })}\n`);
}
