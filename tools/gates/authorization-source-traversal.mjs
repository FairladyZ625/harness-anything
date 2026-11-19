// A function's source syntax is immutable. Compile it once, then advance the
// descriptors currently expanding that body over the same instructions. Each
// descriptor supplies its own bindings, target filter, and ordered edge sink.
import ts from "typescript";
import { isFunctionNode } from "./authorization-flow-graph.mjs";

const bodies = new WeakMap();
const unchanged = (_lanes, live) => live;
const stop = () => 0;

function sequence(steps, respectExit) {
  if (!steps.length) return unchanged;
  return (lanes, live) => {
    let remaining = live;
    for (const step of steps) {
      if (remaining === 0) break;
      const next = step(lanes, remaining);
      if (respectExit) remaining = next;
    }
    return remaining;
  };
}

function compile(node) {
  if (!node || isFunctionNode(node)) return unchanged;
  if (ts.isBlock(node) || ts.isSourceFile(node))
    return sequence(
      node.statements.map(compile).filter((step) => step !== unchanged),
      true,
    );
  if (ts.isThrowStatement(node) || ts.isReturnStatement(node)) return sequence([compile(node.expression), stop], true);
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    const statement = ts.isIfStatement(node);
    const condition = statement ? node.expression : node.condition;
    const visitCondition = compile(condition);
    const left = compile(statement ? node.thenStatement : node.whenTrue);
    const right = compile(statement ? node.elseStatement : node.whenFalse);
    return (lanes, live) => {
      visitCondition(lanes, live);
      let yes = live,
        no = live;
      for (let i = 0; i < lanes.length; i++) {
        if (!(live & (1 << i))) continue;
        const answer = lanes[i].fold(condition);
        if (answer) {
          if (answer.value) no &= ~(1 << i);
          else yes &= ~(1 << i);
        }
      }
      return (yes && left(lanes, yes)) | (no && right(lanes, no));
    };
  }
  const steps = [];
  const promise = ts.isNewExpression(node) && node.expression.getText() === "Promise";
  if (promise || ts.isCallExpression(node))
    steps.push((lanes, live) => {
      for (let i = 0; i < lanes.length; i++)
        if (live & (1 << i)) {
          if (promise) lanes[i].promise(node);
          else lanes[i].call(node);
        }
      return live;
    });
  ts.forEachChild(node, (child) => {
    const step = compile(child);
    if (step !== unchanged) steps.push(step);
  });
  // Exits inside a loop, try or other unmodelled construct do not skip siblings.
  return sequence(steps, false);
}

function visitBody(body, lanes) {
  let program = bodies.get(body);
  if (!program) bodies.set(body, (program = compile(body)));
  program(lanes, (1 << lanes.length) - 1);
}

export function expandSourceFrames(frames) {
  if (frames.length === 1) {
    visitBody(frames[0].body, frames);
    return 1;
  }
  const groups = new Map();
  for (const frame of frames) {
    const body = frame.body;
    if (!groups.has(body)) groups.set(body, []);
    groups.get(body).push(frame);
  }
  for (const [body, lanes] of groups) visitBody(body, lanes);
  return groups.size;
}

const traceActionChildrenCache = new WeakMap();
export function traceActionChildren(root) {
  let cached = traceActionChildrenCache.get(root);
  if (cached) return cached;
  const list = [];
  const collect = (parent) => {
    ts.forEachChild(parent, (child) => {
      if (ts.isTypeNode(child) || isFunctionNode(child)) return;
      if (
        ts.isConditionalExpression(child) ||
        ts.isCallExpression(child) ||
        (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      ) {
        list.push(child);
        return;
      }
      collect(child);
    });
  };
  collect(root);
  traceActionChildrenCache.set(root, list);
  return list;
}
