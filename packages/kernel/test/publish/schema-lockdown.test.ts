import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { PublishableProjectionSchema } from "../../src/index.ts";

test("publishable projection JSON schema rejects extra private/local-only fields", () => {
  const schema = JSON.parse(readFileSync("packages/kernel/schemas/json/publishable-projection.schema.json", "utf8")) as {
    readonly additionalProperties?: boolean;
    readonly properties: Record<string, {
      readonly additionalProperties?: boolean;
      readonly minItems?: number;
      readonly items?: { readonly additionalProperties?: boolean };
      readonly properties?: Record<string, {
        readonly additionalProperties?: boolean;
        readonly minItems?: number;
        readonly items?: { readonly additionalProperties?: boolean };
      }>;
    }>;
  };

  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.links.items?.additionalProperties, false);
  assert.equal(schema.properties.readiness.additionalProperties, false);
  assert.equal(schema.properties.readiness.properties?.evidenceLinks.minItems, 1);
  assert.equal(schema.properties.readiness.properties?.evidenceLinks.items?.additionalProperties, false);
  assert.equal(schema.properties.redactionReport.additionalProperties, false);
  assert.equal(schema.properties.redactionReport.properties?.findings.items?.additionalProperties, false);
});

test("publishable projection runtime schema rejects empty readiness evidence", () => {
  const projection = {
    visibility: "public-safe",
    sourceTaskId: "kr-07",
    title: "Public closeout",
    summary: "Missing evidence links should fail schema decode.",
    links: [],
    readiness: {
      closeoutReadiness: "passed",
      reviewGate: "passed",
      ciGate: "passed",
      evidenceLinks: []
    },
    redactionReport: {
      scannerVersion: "publish-redaction/v1",
      findings: [],
      passed: true
    },
    idempotencyKey: "sha256:empty-evidence"
  };

  assert.throws(() => Schema.decodeUnknownSync(PublishableProjectionSchema)(projection));
});
