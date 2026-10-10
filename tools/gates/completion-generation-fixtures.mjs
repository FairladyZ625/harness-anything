import { readFileSync } from "node:fs";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import { reviewDigest } from "../../packages/kernel/src/domain/review.ts";
import { decodeLegacyEventBytes } from "../../packages/kernel/src/store/legacy-generation-source.ts";
import { makeOfflineCompletionChain } from "../../packages/kernel/src/store/offline-completion-chain.ts";
import {
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../../packages/kernel/src/domain/doc-sync-canonical-events.ts";

export const completionGenerationFixtures = new Map(
  Object.entries(JSON.parse(readFileSync(new URL("./completion-generation-fixtures.json", import.meta.url))).samples),
);

/** dec_5EC2631352B17EE2BF4979E37E: retain the sampled source bytes; only offline conversion admits history. */
export function convertFrozenCompletionSample(body, file) {
  const retained = completionGenerationFixtures.get(file);
  if (!retained || sha256Text(body) !== retained.sha256) throw new Error("retained completion bytes changed");
  const { event: sampled } = decodeLegacyEventBytes(body, file);
  if (validateCurrentCanonicalEvent(sampled).length === 0)
    throw new Error("historical completion entered live admission");
  // The sampler anonymized personId/prose, but retained the original Consent.reviewDigest.
  // Normalize that privacy derivative only for these six byte-locked samples. This is not a
  // production conversion rule: an arbitrary mismatched source reference still fails conversion.
  // Source packet identity and review/consent ids remain unchanged. Full-history conversion uses
  // the unmodified backup, where all six original reviewDigest references match their Review.
  const event = retained.privacyReviewReference
    ? {
        ...sampled,
        payload: {
          ...sampled.payload,
          consent: { ...sampled.payload.consent, reviewDigest: reviewDigest(sampled.payload.review) },
        },
      }
    : sampled;
  // These shape samples contain no snapshot objects. Declare that fixture omission explicitly;
  // never borrow today's installed preset or mint a replacement snapshot.
  const snapshot = event.payload.task.presetSnapshotDigest;
  const converter = makeOfflineCompletionChain({
    generation: 2,
    snapshots: new Map(),
    missingSnapshots: new Set(snapshot ? [snapshot] : []),
    readContent: () => null,
  });
  const converted = converter.convert(event).event;
  const parsed = parseCanonicalEvent(serializePersistedCanonicalEvent(converted));
  const historical = parsed.payload.execution?.submission?.completionContract.historicalAcceptance;
  if (historical && validateCurrentCanonicalEvent(parsed).length === 0)
    throw new Error("converted historical acceptance entered live admission");
  return parsed;
}
