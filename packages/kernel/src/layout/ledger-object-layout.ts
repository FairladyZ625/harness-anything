import { sha256Text } from "../integrity/stable-hash.ts";

/** Ledger object-layout names. flat/v1 is the legacy spelling this store still writes on
 * ledgers that have not migrated yet; sharded-sha256-2/v1 is the default for new ledgers. */
export type LedgerObjectLayout = "flat/v1" | "sharded-sha256-2/v1";
/** What a committed events root actually looks like: one of the two layouts, or both at once. */
export type LedgerLayoutState = LedgerObjectLayout | "mixed";

export function eventObjectShard(opId: string): string {
  return sha256Text(opId).slice(0, 2);
}
export function eventObjectTarget(opId: string): string {
  return `harness/events/${eventObjectShard(opId)}/${opId}.json`;
}
export function eventObjectRelativePath(
  opId: string,
  layout: LedgerObjectLayout = "sharded-sha256-2/v1",
): string {
  return layout === "flat/v1"
    ? `events/${opId}.json`
    : `events/${eventObjectShard(opId)}/${opId}.json`;
}
export function contentObjectRelativePath(
  sha256: string,
  layout: LedgerObjectLayout = "sharded-sha256-2/v1",
): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256))
    throw new Error("content object hash is invalid");
  return layout === "flat/v1"
    ? `objects/sha256/${sha256}`
    : `objects/sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
}
