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

export default {
  meta: {
    type: "problem",
    docs: { description: "Require command, gate, guard, and phase projections to come from domain contracts" },
    schema: [],
    messages: {
      registration: "Register {{kind}} in a *.contract.ts|mjs declaration and derive its projection.",
      registry: "Do not handwrite {{name}} outside a *.contract.ts|mjs declaration."
    }
  },
  create(context) {
    if (isContract(context.filename)) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (REGISTER_METHODS.has(name)) context.report({ node, messageId: "registration", data: { kind: name.slice("register".length) } });
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !REGISTRY_NAME.test(node.id.name)) return;
        if (node.init?.type === "ArrayExpression" || node.init?.type === "ObjectExpression") {
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
