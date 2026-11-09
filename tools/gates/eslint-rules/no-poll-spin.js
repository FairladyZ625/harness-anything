import path from "node:path";

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
// a deadline compared against now(), a loop whose condition reads the clock, a timer that schedules
// what the process under test should be seen doing, a fail-only timer under 20 s (a speed assertion),
// or the shared wall-clock poller. The boundary is the *deadline*, not the mere presence of a loop:
// an unbounded predicate read has no wall-clock judgment in it, and its hang guard is the node:test
// `timeout` option (owner ruling 2026-11-09 on task_6ddecd04b58fe29d6aa32c9736). Event waits go
// through tools/fixtures/event-arrival.ts. Production keeps the CH3 boundary for awaited sub-250 ms
// promise sleeps (the synchronous bridge), while product timers and bounded retries are not waits.
const comparisons = new Set(["<", "<=", ">", ">="]);
const pollHelperModule = /(?:^|\/)wait-for-condition(?:\.[cm]?[jt]s)?$/u;
const pollHelperName = /^eventually/u;
const deadlineOption = /^(?:timeoutMs|timeout|intervalMs)$/u;

// A bounded retry/backoff loop is not a wall-clock deadline: `for (let attempt = 0; attempt < N;
// attempt++)` attempts a fixed number of times and its failure is a real error, not "the clock ran
// out". Only a for-loop with a test is bounded this way; `for (;;)` and clock-conditioned loops are
// still reported.
function insideBoundedFor(node, visitorKeys) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "ForStatement") continue;
    if (current.test && !containsNow(current.test, visitorKeys)) return true;
  }
  return false;
}

// A sub-250 ms timer is a synchronous bridge only when a promise is built around it and awaited
// (`await new Promise((resolve) => setTimeout(resolve, 10))`). A debounce, a teardown escalation or
// a UI refresh timer is product behavior, not a bridge.
function insideAwaitedPromise(node) {
  // The timer must be the executor's expression body: that is a sleep built as
  // `await new Promise((resolve) => setTimeout(resolve, N))`, not a fallback timer inside a longer
  // teardown that also listens for a real event.
  if (node.parent?.type !== "ArrowFunctionExpression" && node.parent?.type !== "FunctionExpression") return false;
  const executor = node.parent;
  if (executor.body.type === "CallExpression" ? executor.body !== node : false) return false;
  const construction = executor.parent;
  return (
    construction?.type === "NewExpression" &&
    construction.callee.type === "Identifier" &&
    construction.callee.name === "Promise" &&
    construction.parent?.type === "AwaitExpression"
  );
}

// A durable predicate helper is only a wall-clock judgment when the call carries a deadline: a
// numeric timeout argument, or a `timeoutMs`/`intervalMs` option. The shared helpers default to
// unbounded and hang-guarded by the node:test `timeout` option (owner ruling 2026-11-09).
function carriesDeadline(node) {
  return node.arguments.some(
    (argument) =>
      (argument.type === "Literal" && typeof argument.value === "number") ||
      (argument.type === "ObjectExpression" &&
        argument.properties.some(
          (property) =>
            property.type === "Property" &&
            deadlineOption.test(property.key.type === "Identifier" ? property.key.name : property.key.value),
        )),
  );
}

function isNowCall(node) {
  return node?.type === "CallExpression" && isClockNow(node.callee);
}

// A product timestamp compared with now() is a content assertion, not a deadline: the test reads
// "the credential expires in the future", not "wait until this instant". A loop that uses the same
// comparison as its condition is still caught by clock-loop.
function isParsedTimestamp(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Date" &&
    node.callee.property?.name === "parse"
  );
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

// Below this delay a fail-only timer judges how fast the process under test is: CI runs integration
// files concurrently on 4-core runners where work units measured 3-4x their uncontended duration.
const watchdogFloorMs = 20_000;

// The squad fixture's measured uncontended maximum was 11,526 ms; the required 16-thread run reached
// 47,600 ms. Five times the uncontended maximum (57,630 ms) is the minimum hang guard; tests use
// 90,000 ms. This floor is a watchdog, never a correctness deadline.
const contentionWatchdogFile = /packages\/daemon\/test\/task-squad-orchestration\.integration\.test\.(?:ts|mjs)$/u;
const contentionWatchdogFloorMs = 11_526 * 5;

// A timer callback either schedules something the process under test must be seen doing, or it only
// completes later (a delay). `setTimeout(resolve, 50)` and `setTimeout(() => resolve(), 50)` are
// delays: no product state is touched, only the wait itself ends. A callback that calls a method on
// an object (`child.send`, `socket.destroy`, `controller.abort`), assigns, throws, or calls `resolve`
// with a value (a Promise.race branch that decides the outcome) schedules an observable state by the
// wall clock. A fail-only callback at/above the floor is a hang guard, not a judgment.
function timerEffect(callback, visitorKeys) {
  if (!callback || !["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type))
    return { hasFailure: false, schedulesState: false };
  let hasFailure = false,
    schedulesState = false;
  function walk(current) {
    if (!current || schedulesState) return;
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
      schedulesState = true;
    if (current.type === "CallExpression") {
      const callee = current.callee;
      const isAssertFail =
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.object.name === "assert" &&
        callee.property.name === "fail";
      const isCompletion =
        callee.type === "Identifier" && ["resolve", "done", "next", "callback", "clearTimeout"].includes(callee.name);
      const resolvesAValue = isCompletion && callee.name === "resolve" && current.arguments.length > 0;
      if ((callee.type === "Identifier" && ["reject", "fail"].includes(callee.name)) || isAssertFail) hasFailure = true;
      else if (!isCompletion || resolvesAValue) schedulesState = true;
    }
    for (const key of visitorKeys[current.type] ?? []) {
      const value = current[key];
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  }
  walk(callback.body);
  return { hasFailure, schedulesState };
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
        "Wall-clock correctness wait requires an exact allowlist entry naming the event that cannot be awaited. Baseline key: {{key}}",
    },
  },
  create(context) {
    const constants = new Map();
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
          const { hasFailure, schedulesState } = timerEffect(node.arguments[0], context.sourceCode.visitorKeys);
          // A timer that schedules product state is a wall-clock judgment, whether or not it fails.
          if (schedulesState) report(node, "scheduled-timer");
          // A fail-only timer below the floor is a speed assertion, not a hang guard.
          else if (hasFailure && milliseconds(node.arguments[1]) < watchdogFloorMs) report(node, "short-watchdog");
        } else if (
          (name === "setInterval" || name === "setTimeout") &&
          milliseconds(node.arguments[1]) < 250 &&
          insideAwaitedPromise(node) &&
          !insideBoundedFor(node, context.sourceCode.visitorKeys)
        )
          report(node, "short-timer");
        if (
          integration &&
          node.callee.type === "Identifier" &&
          pollHelpers.has(node.callee.name) &&
          carriesDeadline(node)
        )
          report(node, "poll-helper");
      },
      BinaryExpression(node) {
        if (!integration) return;
        const contentAssertion =
          comparisons.has(node.operator) &&
          ((isNowCall(node.left) && isParsedTimestamp(node.right)) ||
            (isNowCall(node.right) && isParsedTimestamp(node.left)));
        if (contentAssertion) return;
        if (
          (comparisons.has(node.operator) && (isNowCall(node.left) || isNowCall(node.right))) ||
          (node.operator === "-" && isNowCall(node.right) && !isNowCall(node.left))
        )
          report(node, "clock-deadline");
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
