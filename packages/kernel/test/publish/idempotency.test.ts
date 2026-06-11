import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPublishableProjection,
  createInMemoryPublishIdempotencyLedger,
  reservePublishIdempotencyKey
} from "../../src/index.ts";

test("publish idempotency key is stable for equivalent sorted inputs", () => {
  const first = buildPublishableProjection(validInput([
    { label: "Review", href: "https://example.invalid/pull/7", kind: "review" },
    { label: "Commit", href: "https://example.invalid/commit/abc123", kind: "commit" }
  ]));
  const second = buildPublishableProjection(validInput([
    { label: "Commit", href: "https://example.invalid/commit/abc123", kind: "commit" },
    { label: "Review", href: "https://example.invalid/pull/7", kind: "review" }
  ]));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.projection.idempotencyKey, second.projection.idempotencyKey);
});

test("publish idempotency ledger rejects duplicate publish attempts", () => {
  const built = buildPublishableProjection(validInput([]));
  assert.equal(built.ok, true);
  const ledger = createInMemoryPublishIdempotencyLedger();

  const first = reservePublishIdempotencyKey(built.projection, ledger);
  const second = reservePublishIdempotencyKey(built.projection, ledger);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "duplicate_publish");
});

function validInput(extraLinks: ReadonlyArray<{ readonly label: string; readonly href: string; readonly kind: "artifact" | "commit" | "review" }>) {
  return {
    sourceTaskId: "kr-07",
    title: "Public closeout",
    summary: "Review, CI, and closeout evidence passed.",
    links: extraLinks,
    readiness: {
      closeoutReadiness: "passed" as const,
      reviewGate: "passed" as const,
      ciGate: "passed" as const,
      evidenceLinks: [
        {
          label: "Review evidence",
          href: "https://example.invalid/pull/7",
          kind: "review" as const
        }
      ]
    }
  };
}
