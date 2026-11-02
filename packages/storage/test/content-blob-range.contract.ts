import assert from "node:assert/strict";
import type { TestContext } from "node:test";

export interface ContentBlobRangeReader {
  readContentBlobRange(
    sha256: string,
    offset: number,
    maxBytes: number,
  ): Uint8Array | null | Promise<Uint8Array | null>;
  readContentBlobSize(sha256: string): number | null | Promise<number | null>;
}

export async function assertContentBlobRangeContract(
  t: TestContext,
  reader: ContentBlobRangeReader,
  sha256: string,
  expected: Uint8Array,
): Promise<void> {
  const missing = "f".repeat(64);
  await t.test("returns stored size and null for missing objects", async () => {
    assert.equal(await reader.readContentBlobSize(sha256), expected.byteLength);
    assert.equal(await reader.readContentBlobSize(missing), null);
    assert.equal(await reader.readContentBlobRange(missing, 0, 4), null);
  });
  await t.test("reads bounded windows and clamps at EOF", async () => {
    assert.deepEqual(Buffer.from((await reader.readContentBlobRange(sha256, 2, 4))!), expected.subarray(2, 6));
    assert.deepEqual(
      Buffer.from((await reader.readContentBlobRange(sha256, expected.byteLength - 2, 20))!),
      expected.subarray(-2),
    );
    assert.deepEqual(
      Buffer.from((await reader.readContentBlobRange(sha256, expected.byteLength, 4))!),
      Buffer.alloc(0),
    );
    assert.deepEqual(
      Buffer.from((await reader.readContentBlobRange(sha256, expected.byteLength + 5, 4))!),
      Buffer.alloc(0),
    );
  });
  await t.test("rejects invalid ranges", async () => {
    await assert.rejects(
      Promise.resolve().then(() => reader.readContentBlobRange(sha256, -1, 4)),
      RangeError,
    );
    await assert.rejects(
      Promise.resolve().then(() => reader.readContentBlobRange(sha256, 0, 0)),
      RangeError,
    );
  });
}
