import { sha256Text } from "../integrity/stable-hash.ts";

/** Ledger object-layout names. flat/v1 is the legacy spelling this store still writes on
 * ledgers that have not migrated yet; sharded-sha256-2/v1 is the default for new ledgers. */
export type LedgerObjectLayout = "flat/v1" | "sharded-sha256-2/v1";
/** What a committed events root actually looks like: one of the two layouts, or both at once. */
export type LedgerLayoutState = LedgerObjectLayout | "mixed";

/** A persisted opId becomes a path component, so it has to be a legal filename on every
 * platform this ledger is cloned to. Windows rejects `< > : " / \\ | ? *` and Git for
 * Windows refuses the whole fast-import with `fatal: invalid path`, surfacing far from the
 * code that composed the id.
 *
 * This is a *write* rule, not a naming rule. Read paths resolve opIds that were never
 * events — synthetic receipt ids like `scan:<hash>` and `preview:<hash>` legitimately carry
 * colons, and looking one up must answer "no such event" rather than throw. The assertion
 * therefore guards publication only; see assertBundle in task-event-store.ts. */
const opIdIllegal = /["*:<>?\\|/]/u;
export function assertPublishableOpId(opId: string): string {
  const found = opIdIllegal.exec(opId);
  if (found) throw new Error(`opId ${JSON.stringify(opId)} contains ${JSON.stringify(found[0])}, which cannot be a filename on every supported platform.`);
  return opId;
}
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
