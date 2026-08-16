import { sha256Text } from "../integrity/stable-hash.ts";

export function eventObjectShard(opId: string): string {
  return sha256Text(opId).slice(0, 2);
}
export function eventObjectTarget(opId: string): string {
  return `harness/events/${eventObjectShard(opId)}/${opId}.json`;
}
export function eventObjectRelativePath(opId: string): string {
  return `events/${eventObjectShard(opId)}/${opId}.json`;
}
export function contentObjectRelativePath(sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256))
    throw new Error("content object hash is invalid");
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
}
