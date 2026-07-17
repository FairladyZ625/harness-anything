import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDaemonLogPageResult } from "../src/renderer/api-client.ts";

describe("readDaemonLogPageResult", () => {
  it("accepts the canonical daemon-log-page/v1 fixture", () => {
    const fixture = JSON.parse(readFileSync(
      fileURLToPath(new URL("../../daemon/fixtures/api-schemas/daemon-log-page__v1/valid.json", import.meta.url)),
      "utf8"
    )) as unknown;
    const page = readDaemonLogPageResult(fixture);
    expect(page.schema).toBe("daemon-log-page/v1");
    expect(page.entries[0]?.redaction.policy).toBe("runtime-log-redaction/v1");
  });

  it("rejects malformed pages before renderer consumption", () => {
    expect(() => readDaemonLogPageResult({
      schema: "daemon-log-page/v1",
      entries: [],
      nextCursor: null,
      truncated: false,
      droppedCount: -1
    })).toThrow(/outside daemon-log-page\/v1/u);
  });
});
