const REGISTER_METHODS = new Set(["registerCommand", "registerGate", "registerGuard", "registerPhase"]);
const REGISTRY_NAME = /(?:command|gate|guard|phase)(?:Registry|Catalog|List|Manifest|Definitions?)$/u;

function propertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function calleeName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && !callee.computed) return propertyName(callee.property);
  return null;
}

function isContract(filename) {
  return /\.contract\.(?:mjs|ts)$/u.test(filename.replaceAll("\\", "/"));
}

function projectionArray(node) {
  if (node?.type !== "ArrayExpression") return false;
  return node.elements.some((entry) => {
    if (entry?.type !== "ObjectExpression") return false;
    const fields = new Set(entry.properties.map((property) => propertyName(property.key)).filter(Boolean));
    return (fields.has("usage") && fields.has("summary")) || (fields.has("method") && fields.has("requiresRepo"));
  });
}

function containsFlagLiteral(node) {
  if (node?.type === "Literal") return typeof node.value === "string" && node.value.startsWith("--");
  if (node?.type === "ArrayExpression") return node.elements.some(containsFlagLiteral);
  if (node?.type === "ConditionalExpression") return containsFlagLiteral(node.consequent) || containsFlagLiteral(node.alternate);
  return false;
}

function isCliSource(filename) {
  return /(?:^|\/)packages\/cli\/src\//u.test(filename.replaceAll("\\", "/"));
}

function contractSource(node) {
  if (node?.type === "MemberExpression" && ["inputs", "flags"].includes(propertyName(node.property))) return true;
  return node?.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
    && propertyName(node.callee.property) === "filter" && contractSource(node.callee.object);
}

function contractProjection(node) {
  return node?.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
    && ["map", "flatMap"].includes(propertyName(node.callee.property)) && contractSource(node.callee.object);
}

function manualFlagSet(node, filename) {
  if (node?.type !== "NewExpression" || node.callee.type !== "Identifier" || node.callee.name !== "Set") return false;
  const source = node.arguments[0];
  return containsFlagLiteral(source) || isCliSource(filename) && source !== undefined && !contractProjection(source);
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Require command, gate, guard, and phase projections to come from domain contracts" },
    schema: [],
    messages: {
      registration: "Register {{kind}} in a *.contract.ts|mjs declaration and derive its projection.",
      registry: "Do not handwrite {{name}} outside a *.contract.ts|mjs declaration.",
      flagDirectory: "Do not handwrite a CLI flag directory; derive it from a *.contract.ts|mjs declaration."
    }
  },
  create(context) {
    if (isContract(context.filename)) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (REGISTER_METHODS.has(name)) context.report({ node, messageId: "registration", data: { kind: name.slice("register".length) } });
      },
      NewExpression(node) {
        if (manualFlagSet(node, context.filename)) context.report({ node, messageId: "flagDirectory" });
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;
        if ((REGISTRY_NAME.test(node.id.name) && (node.init?.type === "ArrayExpression" || node.init?.type === "ObjectExpression")) || projectionArray(node.init)) {
          context.report({ node: node.init, messageId: "registry", data: { name: node.id.name } });
        }
      },
      Property(node) {
        const name = propertyName(node.key);
        if (name !== null && REGISTRY_NAME.test(name) && (node.value.type === "ArrayExpression" || node.value.type === "ObjectExpression")) {
          context.report({ node: node.value, messageId: "registry", data: { name } });
        }
      }
    };
  }
};
