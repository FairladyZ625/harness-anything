// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonAdmissionBudget, daemonAdmissionBytes } from "../../src/daemon/admission-budget.ts";

const sessionSizedBytes = 273_127;

function noise(byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  for (let index = 0; index < byteLength; index += 1) bytes[index] = (index * 31 + 7) % 256;
  return bytes;
}

test("admission charges a binary payload its real byteLength", () => {
  const bytes = noise(sessionSizedBytes);
  const shapes: ReadonlyArray<readonly [string, ArrayBufferView | ArrayBuffer, number]> = [
    ["Buffer", bytes, bytes.byteLength],
    ["Uint8Array", new Uint8Array(bytes), bytes.byteLength],
    ["DataView", new DataView(bytes.buffer, bytes.byteOffset, 64), 64],
    ["subview", new Uint8Array(bytes.buffer, bytes.byteOffset + 8, 32), 32],
    ["ArrayBuffer", bytes.buffer.slice(0, 128), 128]
  ];
  for (const [name, value, expected] of shapes) {
    assert.equal(daemonAdmissionBytes(value), expected, `${name} must be charged its byteLength`);
  }
  // The defect this pins down: JSON.stringify renders a Buffer as
  // {"type":"Buffer","data":[...]} and a Uint8Array as {"0":12,...}, so any
  // measurement that reaches for JSON.stringify inflates binary several fold.
  assert.ok(Buffer.byteLength(JSON.stringify(bytes), "utf8") > bytes.byteLength * 3);
  assert.ok(Buffer.byteLength(JSON.stringify(new Uint8Array(bytes)), "utf8") > bytes.byteLength * 10);
});

test("admission charges a nested binary field its real byteLength and nothing more", () => {
  const envelope = noise(sessionSizedBytes);
  const empty = { requestId: "req_admission", presentationToken: noise(0), envelope: noise(0) };
  const attempt = { requestId: "req_admission", presentationToken: noise(1_024), envelope };

  const delta = daemonAdmissionBytes(attempt) - daemonAdmissionBytes(empty);
  assert.equal(delta, 1_024 + envelope.byteLength);

  const truth = Buffer.byteLength(attempt.requestId, "utf8") + 1_024 + envelope.byteLength;
  const framing = daemonAdmissionBytes(attempt) - truth;
  assert.ok(framing >= 0 && framing < 128, `structural framing must stay negligible, got ${framing}`);
});

test("admission keeps exact JSON accounting for payloads with no binary field", () => {
  const values: ReadonlyArray<unknown> = [
    null,
    undefined,
    0,
    -12.5,
    true,
    "plain",
    "quote\" backslash\\ newline\n tab\t accent-é han-中 emoji-\u{1f600}",
    [],
    {},
    [1, "two", null, [3, { four: false }]],
    { b: 1, a: [null, { deep: { deeper: "x" } }], skipped: undefined },
    { taskId: "task_01", ops: [{ kind: "doc_write", payload: { body: "x".repeat(4_096) } }] }
  ];
  for (const value of values) {
    assert.equal(
      daemonAdmissionBytes(value),
      Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8"),
      `JSON-only payload must keep its exact JSON size: ${String(JSON.stringify(value))}`
    );
  }
});

test("a binary payload that fits the configured limit is admitted", () => {
  // Half a megabyte of envelope fits the shipped 1MB budget on its real bytes
  // and does not fit it once rendered as JSON, which is how a session export
  // well inside the limit was rejected as `admission_payload_exceeds_limit`.
  const envelope = noise(512 * 1024);
  const attempt = { requestId: "req_admission", presentationToken: noise(1_024), envelope };
  const budget = createDaemonAdmissionBudget({
    maxOperations: 1_024,
    maxBytes: 1024 * 1024,
    reservedOperationsPerPlane: 32,
    reservedBytesPerPlane: 64 * 1024
  });

  assert.ok(Buffer.byteLength(JSON.stringify(attempt), "utf8") > 1024 * 1024 - 64 * 1024);
  const bytes = daemonAdmissionBytes(attempt);
  const admitted = budget.reserve({ plane: "authority", operations: 1, bytes });
  assert.equal(admitted.ok, true, `a ${envelope.byteLength}-byte envelope must fit the 1MB budget, charged ${bytes}`);
  if (admitted.ok) admitted.reservation.release();
});

test("an oversized binary payload is rejected with its real byte count", () => {
  const envelope = noise(2 * 1024 * 1024);
  const attempt = { requestId: "req_admission", presentationToken: noise(1_024), envelope };
  const budget = createDaemonAdmissionBudget({
    maxOperations: 1_024,
    maxBytes: 1024 * 1024,
    reservedOperationsPerPlane: 32,
    reservedBytesPerPlane: 64 * 1024
  });

  const bytes = daemonAdmissionBytes(attempt);
  const rejection = budget.reserve({ plane: "authority", operations: 1, bytes });
  assert.equal(rejection.ok, false);
  if (rejection.ok) return;
  assert.equal(rejection.error._tag === "WriteRejected" ? rejection.error.code : undefined, "admission_payload_exceeds_limit");
  // The number the operator reads has to be the number of bytes they sent.
  assert.match(
    rejection.error._tag === "WriteRejected" ? rejection.error.reason : "",
    new RegExp(`bytes: requested ${bytes}, limit ${1024 * 1024 - 64 * 1024}`, "u")
  );
  assert.ok(bytes < envelope.byteLength + 4_096, `charged ${bytes} for a ${envelope.byteLength}-byte envelope`);
});
