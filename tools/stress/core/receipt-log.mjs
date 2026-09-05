/**
 * Frozen S1 interface for S2-S4.
 *
 * Exports:
 * - openReceiptLog({ file, targetRoots, campaignId, seed })
 * - readReceiptLog(file)
 * - classifyReceiptLog(log)
 *
 * A request is fsynced before its adapter is invoked. A terminal receipt is
 * fsynced before control returns to the controller. The file must be outside
 * every target root so loss of the target cannot erase the acceptance record.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

const schema = "sqlite-stress-receipt-log/v1";

export function openReceiptLog({ file, targetRoots, campaignId, seed }) {
  const resolvedFile = path.resolve(file);
  for (const targetRoot of targetRoots) assertOutside(resolvedFile, path.resolve(targetRoot));
  mkdirSync(path.dirname(resolvedFile), { recursive: true });
  const descriptor = openSync(resolvedFile, "wx", 0o600);
  let closed = false;
  const append = (record) => {
    if (closed) throw new Error("receipt log is closed");
    writeSync(descriptor, `${JSON.stringify({ schema, ...record })}\n`, null, "utf8");
    fsyncSync(descriptor);
  };
  append({ type: "campaign_started", campaignId, seed, recordedAt: new Date().toISOString() });
  return {
    file: resolvedFile,
    recordRequest: (request) =>
      append({
        type: "request",
        campaignId,
        recordedAt: new Date().toISOString(),
        request,
      }),
    recordReceipt: (requestId, receipt) =>
      append({
        type: "receipt",
        campaignId,
        recordedAt: new Date().toISOString(),
        requestId,
        receipt,
      }),
    close: () => {
      if (closed) return;
      append({ type: "campaign_completed", campaignId, recordedAt: new Date().toISOString() });
      closed = true;
      closeSync(descriptor);
    },
  };
}

export function readReceiptLog(file) {
  if (!existsSync(file))
    return {
      schema,
      complete: false,
      records: [],
      errors: ["receipt log is missing"],
    };
  const records = [];
  const errors = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      const record = JSON.parse(line);
      if (record?.schema !== schema) errors.push(`line ${index + 1} has an unknown schema`);
      else records.push(record);
    } catch {
      errors.push(`line ${index + 1} is not JSON`);
    }
  }
  const started = records[0]?.type === "campaign_started";
  const completed = records.at(-1)?.type === "campaign_completed";
  if (!started) errors.push("campaign start record is missing");
  if (!completed) errors.push("campaign completion record is missing");
  return { schema, complete: errors.length === 0, records, errors };
}

export function classifyReceiptLog(log) {
  const requests = log.records.filter((record) => record.type === "request").map((record) => record.request);
  const receiptRows = log.records.filter((record) => record.type === "receipt");
  const receipts = new Map();
  const errors = [...log.errors];
  for (const row of receiptRows) {
    if (receipts.has(row.requestId)) errors.push(`request ${row.requestId} has more than one terminal receipt`);
    receipts.set(row.requestId, row.receipt);
  }
  const accepted = [];
  const rejected = [];
  const unacknowledged = [];
  for (const request of requests) {
    const receipt = receipts.get(request.requestId);
    if (receipt?.status === "accepted_durable") accepted.push({ request, receipt });
    else if (receipt?.status === "rejected") rejected.push({ request, receipt });
    else if (receipt === undefined) unacknowledged.push({ request, receipt: null });
    else errors.push(`request ${request.requestId} has invalid terminal status ${String(receipt.status)}`);
  }
  return {
    complete: log.complete && errors.length === 0,
    accepted,
    rejected,
    unacknowledged,
    errors,
  };
}

function assertOutside(file, root) {
  const relative = path.relative(root, file);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    throw new Error(`receipt log must live outside target root ${root}`);
}
