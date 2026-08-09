import {
  strictArray,
  strictEnum,
  strictLiteral,
  strictObject,
  strictString
} from "./strict-command-schema.ts";

const pendingClassification = strictObject({
  opId: strictString,
  disposition: strictEnum("retryable-not-committed", "indeterminate"),
  recordedTupleDigest: strictString,
  evidenceRef: strictString
});

/**
 * Authority cutover controls cross the repo-write child boundary because the
 * production daemon keeps no authority engine of its own; the engine lives in
 * the child. These schemas are the wire shape for that crossing.
 */
export const repoWriteAuthorityCutoverActionSchemas = {
  "authority-cutover-status": strictObject({
    kind: strictLiteral("authority-cutover-status")
  }),
  "authority-cutover-drain": strictObject({
    kind: strictLiteral("authority-cutover-drain"),
    classifications: strictArray(pendingClassification)
  }),
  "authority-cutover-scan": strictObject({
    kind: strictLiteral("authority-cutover-scan"),
    profileId: strictLiteral("production-final-scan/v1")
  }),
  "authority-cutover-confirm": strictObject({
    kind: strictLiteral("authority-cutover-confirm"),
    firstScanId: strictString,
    secondScanId: strictString
  }),
  "authority-cutover-boundary": strictObject({
    kind: strictLiteral("authority-cutover-boundary"),
    boundaryId: strictString,
    equalityReceiptId: strictString,
    expectedSelectedSchemaTupleDigest: strictString
  }),
  "authority-cutover-freeze": strictObject({
    kind: strictLiteral("authority-cutover-freeze"),
    reason: strictString,
    expectedBoundaryReceiptDigest: strictString
  }),
  "authority-cutover-re-enable": strictObject({
    kind: strictLiteral("authority-cutover-re-enable"),
    boundaryId: strictString,
    expectedFreezeReceiptDigest: strictString,
    equalityReceiptId: strictString,
    forwardFixRef: strictString
  })
} as const;
