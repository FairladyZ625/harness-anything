import { createHash } from "node:crypto";
import path from "node:path";

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression"
]);
const SUCCESS_WORDS = new Set(["clean", "ok", "success", "succeeded"]);

function normalizedFilename(filename) {
  const relative = path.isAbsolute(filename) ? path.relative(process.cwd(), filename) : filename;
  return relative.replaceAll("\\", "/");
}

function contentHash(sourceText) {
  // Baselines are generated from LF sources; hashing a CRLF checkout's raw text would
  // never match them, failing lint on every Windows (core.autocrlf=true) checkout.
  return createHash("sha256").update(sourceText.replaceAll("\r\n", "\n")).digest("hex");
}

function catchFingerprint(filename, node, sourceText) {
  const location = `${node.loc.start.line}:${node.loc.start.column + 1}`;
  return `${normalizedFilename(filename)}:${location}#${contentHash(sourceText)}`;
}

// Baseline membership deliberately ignores the line:column recorded in each stored
// key. A pure reformat (Prettier, an unrelated edit earlier in the file) shifts every
// catch clause's line number without touching its own text — the fingerprint's hash
// component already proves identity; requiring position to match too turns any reflow
// of the file into a false new violation for a catch clause nobody changed. Two catch
// clauses in the same file that happen to share byte-identical bodies (and therefore a
// hash collision) already both exist in the baseline today, so collapsing them to one
// membership key changes nothing about what those specific clauses are allowed to do.
function baselineLocationIndependentKey(filename, hash) {
  return `${normalizedFilename(filename)}#${hash}`;
}

function baselineMembership(baselineEntries) {
  const keys = new Set();
  for (const entry of baselineEntries) {
    const hashIndex = entry.indexOf("#");
    if (hashIndex === -1) continue;
    const pathAndLocation = entry.slice(0, hashIndex);
    const hash = entry.slice(hashIndex + 1);
    const colonIndex = pathAndLocation.lastIndexOf(":", pathAndLocation.lastIndexOf(":") - 1);
    const filePath = colonIndex === -1 ? pathAndLocation : pathAndLocation.slice(0, colonIndex);
    keys.add(baselineLocationIndependentKey(filePath, hash));
  }
  return keys;
}

function calleeName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return callee.property.name;
  return null;
}

function walk(node, visitorKeys, visit, isRoot = true) {
  if (!node || (!isRoot && FUNCTION_NODE_TYPES.has(node.type))) return;
  visit(node);
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitorKeys, visit, false);
    } else {
      walk(value, visitorKeys, visit, false);
    }
  }
}

function successLike(node) {
  if (node === null || node === undefined) return true;
  if (node.type === "Identifier") return node.name === "undefined" || SUCCESS_WORDS.has(node.name);
  if (node.type === "UnaryExpression" && node.operator === "void") return true;
  if (node.type === "Literal") return node.value === null || node.value === true || (typeof node.value === "string" && SUCCESS_WORDS.has(node.value.toLowerCase()));
  if (node.type === "CallExpression") return SUCCESS_WORDS.has(calleeName(node.callee));
  if (node.type !== "ObjectExpression") return false;
  return node.properties.some((property) => {
    if (property.type !== "Property" || property.computed) return false;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
    if ((key === "ok" || key === "success") && property.value.type === "Literal" && property.value.value === true) return true;
    if (!["kind", "outcome", "result", "status", "verdict"].includes(key)) return false;
    return property.value.type === "Literal" && typeof property.value.value === "string" && SUCCESS_WORDS.has(property.value.value.toLowerCase());
  });
}

function statementTerminates(statement) {
  if (!statement) return false;
  if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") return true;
  if (statement.type === "BlockStatement") return statementTerminates(statement.body.at(-1));
  if (statement.type === "IfStatement") return statement.alternate !== null
    && statementTerminates(statement.consequent)
    && statementTerminates(statement.alternate);
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require caught failures to be propagated, explicitly consumed, or returned as failures"
    },
    schema: [{
      type: "object",
      properties: {
        baseline: { type: "array", items: { type: "string" }, uniqueItems: true }
      },
      additionalProperties: false
    }],
    messages: {
      fallthrough: "Caught failure can fall through without rethrow or consumeKnownError(). Baseline key: {{fingerprint}}",
      success: "Caught failure is projected as undefined or success without consumeKnownError(). Baseline key: {{fingerprint}}"
    }
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const baselineKeys = baselineMembership(context.options[0]?.baseline ?? []);
    return {
      CatchClause(node) {
        const catchSourceText = sourceCode.getText(node);
        const fingerprint = catchFingerprint(context.filename, node, catchSourceText);
        const locationIndependentKey = baselineLocationIndependentKey(context.filename, contentHash(catchSourceText));
        if (baselineKeys.has(locationIndependentKey)) return;

        let explicitlyConsumed = false;
        const suspiciousReturns = [];
        walk(node.body, sourceCode.visitorKeys, (child) => {
          if (child.type === "CallExpression" && calleeName(child.callee) === "consumeKnownError") explicitlyConsumed = true;
          if (child.type === "ReturnStatement" && successLike(child.argument)) suspiciousReturns.push(child);
        });
        if (explicitlyConsumed) return;

        for (const returnNode of suspiciousReturns) {
          context.report({ node: returnNode, messageId: "success", data: { fingerprint } });
        }
        if (!statementTerminates(node.body.body.at(-1))) {
          context.report({ node: node.body, messageId: "fallthrough", data: { fingerprint } });
        }
      }
    };
  }
};
