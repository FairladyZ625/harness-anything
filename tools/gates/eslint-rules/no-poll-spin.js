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

// Integration tests (dec_25B3C380F6FB9D4D4A1E27921E CH1) may not judge correctness by the wall clock:
// a deadline compared against now(), a timer that schedules what the process under test should be
// seen doing, a self-written poll/waitFor loop, or the shared wall-clock poller. Waits go through
// tools/fixtures/event-arrival.ts; node:test `timeout` and fail-only timers are hang guards.
const comparisons = new Set(["<", "<=", ">", ">="]);
const selfPollName = /^(?:waitFor|waitUntil|poll|eventually|until|retry)/iu;
const pollHelperModule = /(?:^|\/)wait-for-condition(?:\.[cm]?[jt]s)?$/u;
const pollHelperName = /^eventually/u;

function isNowCall(node) {
  return node?.type === "CallExpression" && isClockNow(node.callee);
}

function definedName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? null;
  if (node.parent?.type === "VariableDeclarator" && node.parent.id.type === "Identifier") return node.parent.id.name;
  return null;
}

function containsLoop(node, visitorKeys) {
  let found = false;
  function walk(current) {
    if (!current || found) return;
    if (loopTypes.has(current.type) || current.type === "ForOfStatement" || current.type === "ForInStatement")
      found = true;
    for (const key of visitorKeys[current.type] ?? []) {
      const value = current[key];
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  }
  walk(node);
  return found;
}

// Below this delay a fail-only timer judges how fast the process under test is: CI runs integration
// files concurrently on 4-core runners where work units measured 3-4x their uncontended duration.
const watchdogFloorMs = 20_000;

// The squad fixture's measured uncontended maximum was 11,526 ms; the required 16-thread run reached
// 47,600 ms. Five times the uncontended maximum (57,630 ms) is the minimum hang guard; tests use
// 90,000 ms. This floor is a watchdog, never a correctness deadline.
const contentionWatchdogFile = /packages\/daemon\/test\/task-squad-orchestration\.integration\.test\.(?:ts|mjs)$/u;
const contentionWatchdogFloorMs = 11_526 * 5;

// A watchdog is a timer whose callback only ends the test as failed: it rejects, throws, fails an
// assertion, or clears its own timer before doing so. It bounds a hang and never decides what the
// process under test should be doing. Any other timer callback (resolve a sleep, send the child a
// message, destroy a socket, or kill the child as a scripted step) schedules an observable state
// by the wall clock.
function isWatchdog(callback, visitorKeys) {
  if (!callback || !["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type)) return false;
  let hasFailure = false,
    forbiddenAction = false;
  function walk(current) {
    if (!current || forbiddenAction) return;
    if (current.type === "ThrowStatement") hasFailure = true;
    if (
      [
        "AssignmentExpression",
        "UpdateExpression",
        "TaggedTemplateExpression",
        "AwaitExpression",
        "YieldExpression",
        "ImportExpression",
      ].includes(current.type) ||
      (current.type === "UnaryExpression" && current.operator === "delete") ||
      (current.type === "NewExpression" &&
        (current.callee.type !== "Identifier" ||
          !/^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|AggregateError)$/u.test(
            current.callee.name,
          )))
    )
      forbiddenAction = true;
    if (current.type === "CallExpression") {
      const callee = current.callee;
      const isAssertFail =
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.object.name === "assert" &&
        callee.property.name === "fail";
      if ((callee.type === "Identifier" && ["reject", "fail"].includes(callee.name)) || isAssertFail) hasFailure = true;
      else if (callee.type !== "Identifier" || callee.name !== "clearTimeout") forbiddenAction = true;
    }
    for (const key of visitorKeys[current.type] ?? []) {
      const value = current[key];
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  }
  walk(callback.body);
  return hasFailure && !forbiddenAction;
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
        properties: {
          baseline: { type: "array", items: { type: "string" } },
          root: { type: "string" },
          integration: { type: "boolean" },
        },
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
    const integration = context.options[0]?.integration === true;
    const pollHelpers = new Set();
    const report = (node, kind, symbol = enclosingFunction(node)) => {
      const key = `${normalized(context.filename, cwd)}#${symbol}#${kind}`;
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
        const helperModule = pollHelperModule.test(String(node.source.value));
        for (const specifier of node.specifiers) {
          if (
            integration &&
            specifier.type === "ImportSpecifier" &&
            (helperModule || pollHelperName.test(specifier.imported.name))
          )
            pollHelpers.add(specifier.local.name);
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
        if (integration && name === "test" && contentionWatchdogFile.test(normalized(context.filename, cwd))) {
          const options = node.arguments.find((argument) => argument.type === "ObjectExpression");
          const timeout = options?.properties.find(
            (property) =>
              property.type === "Property" && property.key.type === "Identifier" && property.key.name === "timeout",
          )?.value;
          const timeoutMs = milliseconds(timeout);
          if (!Number.isFinite(timeoutMs) || timeoutMs < contentionWatchdogFloorMs) report(node, "contention-watchdog");
        }
        if (integration && (name === "setInterval" || name === "setTimeout")) {
          // A fail-only timer whose delay resolves below the floor is a speed assertion, not a hang guard.
          if (!isWatchdog(node.arguments[0], context.sourceCode.visitorKeys)) report(node, "scheduled-timer");
          else if (milliseconds(node.arguments[1]) < watchdogFloorMs) report(node, "short-watchdog");
        } else if ((name === "setInterval" || name === "setTimeout") && milliseconds(node.arguments[1]) < 250)
          report(node, "short-timer");
        if (integration && node.callee.type === "Identifier" && pollHelpers.has(node.callee.name))
          report(node, "poll-helper");
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
      BinaryExpression(node) {
        if (!integration) return;
        if (
          (comparisons.has(node.operator) && (isNowCall(node.left) || isNowCall(node.right))) ||
          (node.operator === "-" && isNowCall(node.right) && !isNowCall(node.left))
        )
          report(node, "clock-deadline");
      },
      "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression"(node) {
        if (!integration) return;
        const name = definedName(node);
        if (name && selfPollName.test(name) && containsLoop(node.body, context.sourceCode.visitorKeys))
          report(node, "self-poll", name);
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
