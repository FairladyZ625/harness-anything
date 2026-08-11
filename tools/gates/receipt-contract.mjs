const OUTCOMES = Object.freeze(["applied", "pending", "indeterminate", "rejected"]);
const UNCERTAIN_OUTCOMES = new Set(["indeterminate", "rejected"]);
const REQUIRED_ERROR_FIELDS = Object.freeze(["code", "origin", "nextAction", "opId"]);

export const RECEIPT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["outcome"],
  properties: {
    outcome: { enum: OUTCOMES },
    opId: { type: "string", minLength: 1 },
    revision: { type: "integer", minimum: 0 },
    code: { type: "string", minLength: 1 },
    origin: { type: "string", minLength: 1 },
    nextAction: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1 }
  },
  allOf: [{
    if: { properties: { outcome: { enum: [...UNCERTAIN_OUTCOMES] } }, required: ["outcome"] },
    then: { required: REQUIRED_ERROR_FIELDS }
  }],
  additionalProperties: false
});

export class ReceiptContractError extends Error {
  constructor(errors) {
    super(`invalid receipt: ${errors.join("; ")}`);
    this.name = "ReceiptContractError";
    this.errors = errors;
  }
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateReceipt(receipt, options = {}) {
  const errors = [];
  if (!isPlainObject(receipt)) return ["receipt must be a JSON object"];

  const allowed = new Set(Object.keys(RECEIPT_SCHEMA.properties));
  for (const key of Object.keys(receipt)) {
    if (!allowed.has(key)) errors.push(`unexpected field: ${key}`);
  }
  if (!OUTCOMES.includes(receipt.outcome)) errors.push(`outcome must be one of ${OUTCOMES.join(", ")}`);
  if (Object.hasOwn(receipt, "revision") && (!Number.isInteger(receipt.revision) || receipt.revision < 0)) {
    errors.push("revision must be a non-negative integer");
  }
  for (const key of ["opId", "code", "origin", "nextAction", "evidence"]) {
    if (Object.hasOwn(receipt, key) && (typeof receipt[key] !== "string" || receipt[key].trim().length === 0)) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (UNCERTAIN_OUTCOMES.has(receipt.outcome)) {
    for (const key of REQUIRED_ERROR_FIELDS) {
      if (typeof receipt[key] !== "string" || receipt[key].trim().length === 0) errors.push(`${key} is required for ${receipt.outcome}`);
    }
  }
  if (options.hasEvidence === false) {
    if (receipt.outcome !== "indeterminate") errors.push("a receipt without evidence must be indeterminate");
    if (receipt.origin !== "N/A") errors.push('a receipt without evidence must use origin "N/A"');
  }
  return errors;
}

export function createReceipt(receipt, options = {}) {
  const errors = validateReceipt(receipt, options);
  if (errors.length > 0) throw new ReceiptContractError(errors);
  return Object.freeze({ ...receipt });
}
