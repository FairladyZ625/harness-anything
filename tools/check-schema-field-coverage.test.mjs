// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { entityFieldContracts } from "../packages/kernel/src/entity/field-contracts.ts";
import { checkEntityFieldCoverage } from "./check-schema-field-coverage.mjs";

test("schema field coverage accepts the repository field contracts", () => {
  assert.deepEqual(checkEntityFieldCoverage(), []);
});

test("schema field coverage fails closed when a field contract is missing", () => {
  const { title: _missingTitle, ...decisionWithoutTitle } = entityFieldContracts.decision;
  const violations = checkEntityFieldCoverage({
    ...entityFieldContracts,
    decision: decisionWithoutTitle
  });
  assert.match(violations.join("\n"), /decision: missing field contracts: title/u);
});

test("schema field coverage fails closed when an amendable field has no amend surface", () => {
  const violations = checkEntityFieldCoverage({
    ...entityFieldContracts,
    decision: {
      ...entityFieldContracts.decision,
      claims: {
        ...entityFieldContracts.decision.claims,
        write: []
      }
    }
  });
  assert.match(violations.join("\n"), /decision\.claims: amendable field must declare an amend write surface/u);
});
