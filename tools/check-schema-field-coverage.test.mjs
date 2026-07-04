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
      rejected: {
        ...entityFieldContracts.decision.rejected,
        write: []
      }
    }
  });
  assert.match(violations.join("\n"), /decision\.rejected: amendable field must declare an amend write surface/u);
});
