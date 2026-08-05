import type {
  DocSyncChangeV1,
  DocSyncSubmitRequestV1
} from "../doc-sync.ts";
import { docSyncWriterWorkingTreeContentKind } from "../doc-sync.ts";
import {
  strictArray,
  strictEnum,
  strictLiteral,
  strictNullable,
  strictNumber,
  strictObject,
  strictString,
  strictUnion
} from "./strict-command-schema.ts";

const inlineContent = strictObject({
  kind: strictLiteral("inline"),
  body: strictString
});

const referencedContent = strictObject({
  kind: strictLiteral(docSyncWriterWorkingTreeContentKind)
});

const change = strictObject({
  path: strictString,
  baseBlobSha256: strictNullable(strictString),
  newBlobSha256: strictString,
  mediaType: strictString,
  size: strictNumber,
  content: strictUnion(inlineContent, referencedContent)
}, {
  declaredPathClass: strictString,
  declaredZoneClass: strictString,
  declaredBearing: strictString
});

const session = strictObject({}, {
  sessionId: strictString,
  runtime: strictEnum(
    "human", "claude-code", "codex", "zcode", "antigravity", "unknown"
  ),
  source: strictEnum("runtime", "manual"),
  detectedAt: strictString,
  user: strictString
});

const request = strictObject({
  repo: strictObject({ repoId: strictString }),
  payload: strictObject({
    baseLedgerSha: strictString,
    intentId: strictString,
    declaredIntent: strictEnum(
      "prose-edit", "manual-artifact", "generated-artifact", "session-export"
    ),
    changes: strictArray(change)
  })
}, {
  session,
  executor: strictNullable(strictObject({
    kind: strictLiteral("agent"),
    id: strictString
  }))
});

const requestShapeSatisfiesContract = true satisfies
  ReturnType<typeof request.decode> extends DocSyncSubmitRequestV1 ? true : never;
const changeShapeSatisfiesContract = true satisfies
  ReturnType<typeof change.decode> extends DocSyncChangeV1 ? true : never;
void requestShapeSatisfiesContract;
void changeShapeSatisfiesContract;

export function decodeRepoWriteDocSyncSubmitRequest(
  value: unknown,
  path = "$.request"
): DocSyncSubmitRequestV1 {
  return request.decode(value, path) as DocSyncSubmitRequestV1;
}
