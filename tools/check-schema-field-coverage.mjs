#!/usr/bin/env node
import { decisionAmendableFields, entityFieldContracts } from "../packages/kernel/src/domain/entity-field-contracts.ts";
import { loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

// The expected field lists are an external authority
// (tools/gate-allowlists/check-schema-field-coverage.json): this gate used to
// derive expectedFields from entityFieldContracts itself, which made the
// default coverage comparison tautological (ADR-0022:123;
// dec_F5B2CBF8B45042B6DA2824A7FA/CH2b). Both arguments are required so no
// call path can rebuild the self-comparison.
export function checkEntityFieldCoverage(contracts, expectedFields) {
  if (contracts === null || typeof contracts !== "object") throw new Error("contracts must be an object");
  if (expectedFields === null || typeof expectedFields !== "object") {
    throw new Error("expectedFields must be an object");
  }
  const violations = [];
  for (const entityKind of Object.keys(contracts)) {
    if (!Object.hasOwn(expectedFields, entityKind)) {
      violations.push(`${entityKind}: field contracts exist without an external expected field list`);
    }
  }
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
      if (
        (contract.mutability === "immutable" || contract.mutability === "derived") &&
        (!contract.reason || typeof contract.reason !== "string")
      ) {
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
    violations.push(
      `decision: amendable fields must match amend routing: declared=${declaredDecisionAmendable.join(", ")} routed=${routedDecisionAmendable.join(", ")}`,
    );
  }
  return violations;
}

export function loadExpectedFieldLists() {
  const allowlist = loadGateAllowlist("check-schema-field-coverage", { requiredSections: ["expectedFields"] });
  const expectedFields = {};
  for (const entry of allowlist.expectedFields) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.entityKind !== "string" ||
      entry.entityKind.trim() === ""
    ) {
      throw new Error("expectedFields entries must name a non-empty entityKind");
    }
    if (Object.hasOwn(expectedFields, entry.entityKind)) {
      throw new Error(`expectedFields declares entityKind ${entry.entityKind} more than once`);
    }
    if (
      !Array.isArray(entry.fields) ||
      entry.fields.length === 0 ||
      entry.fields.some((field) => typeof field !== "string" || field.trim() === "")
    ) {
      throw new Error(`expectedFields entry for ${entry.entityKind} must be a non-empty list of field names`);
    }
    expectedFields[entry.entityKind] = [...entry.fields].sort();
  }
  return expectedFields;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkEntityFieldCoverage(entityFieldContracts, loadExpectedFieldLists());
  if (violations.length > 0) {
    console.error("Schema field coverage check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("Schema field coverage check passed.");
}
