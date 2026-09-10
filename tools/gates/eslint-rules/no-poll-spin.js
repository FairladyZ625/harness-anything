import path from "node:path";

const loopTypes = new Set(["ForStatement", "WhileStatement", "DoWhileStatement"]);

function normalized(filename, cwd) {
  return (path.isAbsolute(filename) ? path.relative(cwd, filename) : filename).replaceAll("\\", "/");
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "FunctionDeclaration" && current.id) return current.id.name;
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) {
      if (current.parent?.type === "VariableDeclarator" && current.parent.id.type === "Identifier")
        return current.parent.id.name;
      if (current.parent?.type === "Property") return current.parent.key.name ?? current.parent.key.value;
    }
    if (current.type === "MethodDefinition") return current.key.name ?? current.key.value;
  }
  return "<module>";
}

function callName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed) return node.property.name;
  return null;
}

function isClockNow(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    ["Date", "performance"].includes(node.object?.type === "Identifier" ? node.object.name : "") &&
    node.property?.type === "Identifier" &&
    node.property.name === "now"
  );
}

function insideLoop(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) return false;
    if (loopTypes.has(current.type)) return true;
  }
  return false;
}

function containsNow(node, visitorKeys) {
  let found = false;
  function walk(current) {
    if (!current || found) return;
    if (current.type === "CallExpression" && isClockNow(current.callee)) found = true;
    for (const key of visitorKeys[current.type] ?? []) {
      const value = current[key];
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  }
  walk(node);
  return found;
}

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { baseline: { type: "array", items: { type: "string" } }, root: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "Polling/spin wait requires an exact allowlist entry naming the event that cannot be awaited. Baseline key: {{key}}",
    },
  },
  create(context) {
    const constants = new Map();
    const waitAliases = new Set(["delay", "sleep", "setTimeout", "setImmediate"]);
    const baseline = new Set(context.options[0]?.baseline ?? []);
    const cwd = context.options[0]?.root ?? context.getCwd?.() ?? process.cwd();
    const report = (node, kind) => {
      const key = `${normalized(context.filename, cwd)}#${enclosingFunction(node)}#${kind}`;
      if (!baseline.has(key)) context.report({ node, messageId: "forbidden", data: { key } });
    };
    const milliseconds = (node) =>
      node?.type === "Literal" && typeof node.value === "number"
        ? node.value
        : node?.type === "Identifier"
          ? constants.get(node.name)
          : undefined;
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && waitAliases.has(specifier.imported.name)) {
            waitAliases.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init?.type === "Literal" && typeof node.init.value === "number")
          constants.set(node.id.name, node.init.value);
      },
      CallExpression(node) {
        const name = callName(node.callee);
        if ((name === "setInterval" || name === "setTimeout") && milliseconds(node.arguments[1]) < 250)
          report(node, "short-timer");
        if (name === "wait" && node.callee.type === "MemberExpression" && node.callee.object.name === "Atomics")
          report(node, "atomics-wait");
      },
      AwaitExpression(node) {
        if (
          node.argument.type === "CallExpression" &&
          waitAliases.has(callName(node.argument.callee)) &&
          insideLoop(node)
        )
          report(node, "await-in-loop");
      },
      WhileStatement(node) {
        if (containsNow(node.test, context.sourceCode.visitorKeys)) report(node, "clock-loop");
      },
      DoWhileStatement(node) {
        if (containsNow(node.test, context.sourceCode.visitorKeys)) report(node, "clock-loop");
      },
    };
  },
};
