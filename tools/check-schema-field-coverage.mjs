#!/usr/bin/env node
import { decisionAmendableFields, entityFieldContracts } from "../packages/kernel/src/entity/field-contracts.ts";

const defaultExpectedFields = Object.fromEntries(
  Object.entries(entityFieldContracts).map(([entityKind, fields]) => [entityKind, Object.keys(fields).sort()])
);

export function checkEntityFieldCoverage(contracts = entityFieldContracts, expectedFields = defaultExpectedFields) {
  const violations = [];
  for (const [entityKind, expected] of Object.entries(expectedFields)) {
    const fields = contracts[entityKind];
    if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
      violations.push(`${entityKind}: field contract table must not be empty`);
      continue;
    }
    const actual = Object.keys(fields).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const missing = expected.filter((field) => !actual.includes(field));
      const extra = actual.filter((field) => !expected.includes(field));
      if (missing.length > 0) violations.push(`${entityKind}: missing field contracts: ${missing.join(", ")}`);
      if (extra.length > 0) violations.push(`${entityKind}: unknown field contracts: ${extra.join(", ")}`);
    }
    for (const [fieldName, contract] of Object.entries(fields)) {
      const prefix = `${entityKind}.${fieldName}`;
      if (!contract || typeof contract !== "object") {
        violations.push(`${prefix}: missing field contract`);
        continue;
      }
      if (!["immutable", "lifecycle", "amendable", "derived"].includes(contract.mutability)) {
        violations.push(`${prefix}: unsupported mutability ${String(contract.mutability)}`);
      }
      const read = Array.isArray(contract.read) ? contract.read : [];
      if (!read.some((surface) => surface?.kind === "projection" || surface?.kind === "show")) {
        violations.push(`${prefix}: field must be readable through projection or show output`);
      }
      for (const surface of read) {
        if (!surface?.path || typeof surface.path !== "string") {
          violations.push(`${prefix}: read surface must name a path`);
        }
        if (surface?.kind === "projection" && typeof surface.queryable !== "boolean") {
          violations.push(`${prefix}: projection read surface must declare queryable boolean`);
        }
      }

      const write = Array.isArray(contract.write) ? contract.write : [];
      if (contract.mutability === "amendable" && !write.some((surface) => surface?.kind === "amend")) {
        violations.push(`${prefix}: amendable field must declare an amend write surface`);
      }
      if (contract.mutability === "lifecycle" && !write.some((surface) => surface?.kind === "lifecycle")) {
        violations.push(`${prefix}: lifecycle field must declare a lifecycle write surface`);
      }
      if ((contract.mutability === "immutable" || contract.mutability === "derived") && (!contract.reason || typeof contract.reason !== "string")) {
        violations.push(`${prefix}: ${contract.mutability} field must declare a reason`);
      }
      if ((contract.mutability === "immutable" || contract.mutability === "derived") && write.length > 0) {
        violations.push(`${prefix}: ${contract.mutability} field must not declare write surfaces`);
      }
    }
  }
  const declaredDecisionAmendable = Object.entries(contracts.decision ?? {})
    .filter(([, contract]) => contract?.mutability === "amendable")
    .map(([field]) => field)
    .sort();
  const routedDecisionAmendable = [...decisionAmendableFields].sort();
  if (JSON.stringify(declaredDecisionAmendable) !== JSON.stringify(routedDecisionAmendable)) {
    violations.push(`decision: amendable fields must match amend routing: declared=${declaredDecisionAmendable.join(", ")} routed=${routedDecisionAmendable.join(", ")}`);
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkEntityFieldCoverage();
  if (violations.length > 0) {
    console.error("Schema field coverage check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("Schema field coverage check passed.");
}
