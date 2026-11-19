import ts from "typescript";
import { isFunctionNode, memberName, unwrap } from "./authorization-flow-graph.mjs";

const indexes = new WeakMap();

// Every callable found by the strict evaluator comes from authored syntax: a lexical
// binding, an argument/capture, a typed member candidate or a resolved declaration.
// These edges include all branches and nested callables. They can prove absence.
// A possible origin still needs the original frame-sensitive reachability check.
export function sourceOriginFilter(graph, targets) {
  if (targets.length === 0) return () => false;
  let origins = indexes.get(graph);
  if (!origins) indexes.set(graph, (origins = new WeakMap()));
  const reached = new WeakMap(),
    byEnv = new WeakMap(),
    ranges = new Map();
  for (const target of targets) {
    if (!ranges.has(target.file)) ranges.set(target.file, []);
    ranges.get(target.file).push(target);
  }

  function dependencies(tree) {
    if (origins.has(tree)) return origins.get(tree);
    const next = new Set();
    let opaque = false;
    const bindings = new Set();
    function add(binding) {
      if (!binding || bindings.has(binding)) return;
      bindings.add(binding);
      if (binding.kind === "fn" || binding.kind === "class") next.add(binding.node);
      if (binding.kind === "var" && binding.declaration.initializer) next.add(binding.declaration.initializer);
      if (binding.kind !== "import") return;
      const { file } = graph.importTarget(binding);
      if (file) {
        if (binding.exported === "*") next.add(graph.modules.get(file).sourceFile);
        else add(graph.exportedBinding(file, binding.exported));
      }
    }
    function namespace(from, node) {
      const { file } = graph.importTarget({ file: graph.fileOf(node), from });
      if (file) next.add(graph.modules.get(file).sourceFile);
    }
    function visit(node) {
      if (opaque || ts.isTypeNode(node)) return;
      if (node !== tree && isFunctionNode(node)) {
        next.add(node);
        return;
      }
      if (ts.isIdentifier(node)) add(graph.lookup(node.text, node));
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        // Lexical-only sources can resolve sibling methods without a checker signature.
        const owner = ts.findAncestor(node.parent, ts.isClassLike);
        if (owner) next.add(owner);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
        namespace(node.moduleSpecifier.text, node);
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression),
          [specifier] = node.arguments;
        if (callee.kind === ts.SyntaxKind.ImportKeyword && specifier && ts.isStringLiteralLike(specifier))
          namespace(specifier.text, node);
        if (!ts.isIdentifier(callee) || graph.lookup(callee.text, callee)?.kind !== "fn") {
          const declaration = graph.callDeclaration(node);
          if (isFunctionNode(declaration) && declaration.body) next.add(declaration);
        }
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const argument = ts.isElementAccessExpression(callee) ? callee.argumentExpression : null;
          const key = ts.isPropertyAccessExpression(callee)
            ? memberName(callee.name)
            : argument && ts.isStringLiteralLike(argument)
              ? argument.text
              : argument && ts.isNumericLiteral(argument)
                ? String(Number(argument.text))
                : graph.uniqueSymbolKey(argument);
          const have =
            key !== null &&
            (graph.members.hasCandidates ? graph.members.hasCandidates(key) : graph.members.get(key)?.length);
          const signatures = (key === null || have) && graph.memberSignature(callee);
          if (signatures && key === null) opaque = true;
          else if (signatures && graph.members.matching)
            for (const member of graph.members.matching(key, signatures)) next.add(member.value);
          else if (signatures)
            for (const member of graph.members.get(key))
              if (signatures.has(member.declaration) || graph.implementsMember(member.declaration, key, signatures))
                next.add(member.value);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const result = opaque ? null : [...next];
    origins.set(tree, result);
    return result;
  }

  function mayReach(root) {
    if (reached.has(root)) return reached.get(root);
    const seen = new Set(),
      stack = [];
    function enter(node) {
      if (seen.has(node) || reached.get(node) === false) return false;
      if (
        reached.get(node) === true ||
        ranges.get(graph.fileOf(node))?.some(({ start, end }) => node.pos <= start && node.end >= end)
      )
        return true;
      seen.add(node);
      const edges = dependencies(node);
      if (edges === null) return true;
      stack.push({ node, edges, index: 0 });
      return false;
    }
    if (enter(root)) {
      reached.set(root, true);
      return true;
    }
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.index === frame.edges.length) {
        stack.pop();
        continue;
      }
      const edge = frame.edges[frame.index++];
      if (!enter(edge)) continue;
      // Only the active path has a proof. A previously exhausted sibling
      // may still depend on an ancestor through a cycle.
      reached.set(edge, true);
      for (const ancestor of stack) reached.set(ancestor.node, true);
      return true;
    }
    for (const node of seen) reached.set(node, false);
    return false;
  }

  function boundOrigin(bound) {
    return (
      Boolean(bound.expression && mayReach(bound.expression)) ||
      (bound.rest?.some(boundOrigin) ?? false) ||
      mayReachInEnv(bound.env)
    );
  }

  function mayReachInEnv(env) {
    if (!env || env.size === 0) return false;
    if (byEnv.has(env)) return byEnv.get(env);
    const result = [...env.values()].some(boundOrigin);
    byEnv.set(env, result);
    return result;
  }

  return (node, env) => mayReach(node) || mayReachInEnv(graph.internEnv.relevantEnvironment(node, env));
}
