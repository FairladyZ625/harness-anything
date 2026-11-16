// Lexical scope, AST unwrapping, and canonical environment frame interning for the
// durable-authorization static source graph. Kept pure of production symbol names.
import ts from "typescript";

export const EMPTY_ENV = new Map();
// Weak ownership lets detached Programs die after an audit; no module-level table owns ASTs.
const environmentInterners = new WeakMap();

const maxInternedFrames = 10000;

export function registerSourceFileInterner(sourceFile, interner) {
  environmentInterners.set(sourceFile, interner);
}

export function releaseSourceFileInterner(sourceFile, interner) {
  if (environmentInterners.get(sourceFile) === interner) registerSourceFileInterner(sourceFile, undefined);
}

export const isFunctionNode = (node) =>
  Boolean(node) &&
  (ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node));

const SK_PAREN = ts.SyntaxKind.ParenthesizedExpression;
const SK_AS = ts.SyntaxKind.AsExpression;
const SK_SATISFIES = ts.SyntaxKind.SatisfiesExpression;
const SK_NON_NULL = ts.SyntaxKind.NonNullExpression;
const SK_AWAIT = ts.SyntaxKind.AwaitExpression;
const SK_TYPE_ASSERT = ts.SyntaxKind.TypeAssertionExpression;

export function unwrap(node) {
  let current = node;
  while (current) {
    const kind = current.kind;
    if (
      kind === SK_PAREN ||
      kind === SK_AS ||
      kind === SK_SATISFIES ||
      kind === SK_NON_NULL ||
      kind === SK_AWAIT ||
      kind === SK_TYPE_ASSERT
    )
      current = current.expression;
    else break;
  }
  return current;
}

export const memberName = (node) =>
  ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;

export function bindingNames(name, visit, trail = []) {
  if (ts.isIdentifier(name)) return visit(name.text, trail);
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    // A rest element keeps the remaining fields of the same object.
    const key = element.dotDotDotToken
      ? "..."
      : element.propertyName
        ? memberName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
    bindingNames(element.name, visit, [...trail, key]);
  }
}

export function declareStatements(statements, bindings) {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        bindingNames(declaration.name, (name, trail) =>
          bindings.set(name, { kind: "var", declaration, trail, moduleScoped: ts.isSourceFile(statement.parent) }),
        );
    else if (ts.isFunctionDeclaration(statement) && statement.name)
      bindings.set(statement.name.text, { kind: "fn", node: statement });
    else if (ts.isClassDeclaration(statement) && statement.name)
      bindings.set(statement.name.text, { kind: "class", node: statement });
  }
}

export function makeFileOf(relativeFiles, sourceFileOf) {
  return (node) => {
    const source = sourceFileOf(node);
    return relativeFiles.get(source) ?? source.fileName;
  };
}

export function makeEnvironmentInterner(lookup, freeParameters) {
  const ids = new WeakMap(),
    canonical = new WeakSet();
  let frames = new Map(),
    previousFrames = new Map(),
    relevantCache = new WeakMap(),
    lexicalCache = new WeakMap(),
    normalizedBounds = new WeakSet(),
    boundKeys = new WeakMap(),
    nextId = 0;
  function id(value) {
    if (!ids.has(value)) ids.set(value, ++nextId);
    return ids.get(value);
  }
  // A parameter forwarded through another immutable frame still denotes the original
  // argument. Keeping the alias's caller env would create an unbounded chain of copies.
  function argumentBinding(bound) {
    if (normalizedBounds.has(bound)) return bound;
    const input = bound;
    while (bound.expression) {
      const expression = unwrap(bound.expression);
      if (!ts.isIdentifier(expression)) break;
      const binding = lookup(expression.text, expression);
      if (binding?.kind !== "param" || binding.trail.length > 0) break;
      const original = bound.env.get(binding.parameter);
      if (!original) break;
      bound = original;
    }
    // Expanded rest entries remain argument records even when normalization resolves a
    // parameter alias to a root or another bound value rather than an AST expression.
    if (bound.rest) {
      const result = {
        rest: bound.rest.map((entry) => ({ ...argumentBinding(entry), flowArgument: true })),
        env: EMPTY_ENV,
      };
      normalizedBounds.add(result);
      return result;
    }
    if (!bound.expression || bound.env.size === 0) {
      normalizedBounds.add(bound);
      return bound;
    }
    const expression = unwrap(bound.expression),
      binding = ts.isIdentifier(expression) ? lookup(expression.text, expression) : null,
      env =
        binding?.kind === "fn"
          ? lexicalFor(binding.node, bound.env)
          : isFunctionNode(expression)
            ? lexicalFor(expression, bound.env)
            : relevantEnvironment(bound.expression, bound.env);
    const result = env === bound.env ? bound : { ...bound, env };
    normalizedBounds.add(result);
    if (result === input) normalizedBounds.add(input);
    return result;
  }
  function boundKey(bound) {
    if (bound.root) return "root";
    if (normalizedBounds.has(bound)) {
      const cached = boundKeys.get(bound);
      if (cached !== undefined) return cached;
    }
    const key = bound.rest
      ? `rest:[${bound.rest.map(boundKey).join(",")}]`
      : `${id(bound.expression)}@${id(internEnv(bound.env))}`;
    if (normalizedBounds.has(bound)) boundKeys.set(bound, key);
    return key;
  }
  function internCanonicalEntries(entries) {
    if (entries.length === 0) return EMPTY_ENV;
    let key = "";
    for (let index = 0; index < entries.length; index++) {
      const [param, bound] = entries[index];
      if (index > 0) key += ";";
      key += `${id(param)}=${boundKey(bound)}`;
    }
    const current = frames.get(key);
    if (current) return current;
    const promoted = previousFrames.get(key);
    if (frames.size >= maxInternedFrames) {
      previousFrames.clear();
      previousFrames = frames;
      frames = new Map();
    }
    if (promoted) {
      frames.set(key, promoted);
      return promoted;
    }
    const frame = new Map(entries);
    canonical.add(frame);
    frames.set(key, frame);
    return frame;
  }
  function internEnv(entries = EMPTY_ENV) {
    if ((entries.size ?? entries.length) === 0) return EMPTY_ENV;
    if (canonical.has(entries)) return entries;
    const ordered = [...entries].map(([param, bound]) => [id(param), param, argumentBinding(bound)]);
    if (ordered.length === 0) return EMPTY_ENV;
    ordered.sort(([left], [right]) => left - right);
    return internCanonicalEntries(ordered.map(([, param, bound]) => [param, bound]));
  }
  function relevantEnvironment(node, env) {
    if (env.size === 0) return EMPTY_ENV;
    const isCanonical = canonical.has(env);
    let byNode = isCanonical ? relevantCache.get(env) : null;
    if (byNode?.has(node)) return byNode.get(node);
    const parameters = freeParameters(node);
    let result;
    if (parameters.size === 0) result = EMPTY_ENV;
    else {
      let kept = 0;
      for (const [parameter] of env) if (parameters.has(parameter)) kept++;
      if (kept === 0) result = EMPTY_ENV;
      else if (kept === env.size) result = isCanonical ? env : internEnv(env);
      else {
        const entries = [];
        for (const entry of env) if (parameters.has(entry[0])) entries.push(entry);
        result = isCanonical ? internCanonicalEntries(entries) : internEnv(entries);
      }
    }
    if (isCanonical) {
      if (!byNode) relevantCache.set(env, (byNode = new WeakMap()));
      byNode.set(node, result);
    }
    return result;
  }
  function computeLexicalFor(node, env) {
    const relevant = relevantEnvironment(node, env);
    if (relevant.size === 0 || !ts.isFunctionLike(node)) return relevant;
    let dropsOwn = false;
    for (const [parameter] of relevant)
      if (parameter.parent === node) {
        dropsOwn = true;
        break;
      }
    if (!dropsOwn) return relevant;
    const captured = [];
    for (const entry of relevant) if (entry[0].parent !== node) captured.push(entry);
    return captured.length === 0 ? EMPTY_ENV : internCanonicalEntries(captured);
  }
  const singleEnvParams = new WeakMap();
  function lexicalFor(node, env = EMPTY_ENV) {
    if (env.size === 0) return EMPTY_ENV;
    const params = freeParameters(node);
    if (params.size === 0) return EMPTY_ENV;
    if (!canonical.has(env)) return computeLexicalFor(node, env);
    if (env.size === 1) {
      let param = singleEnvParams.get(env);
      if (param === undefined) {
        param = env.keys().next().value;
        singleEnvParams.set(env, param);
      }
      if (!params.has(param)) return EMPTY_ENV;
      return param.parent === node && ts.isFunctionLike(node) ? EMPTY_ENV : env;
    }
    let byNode = lexicalCache.get(env);
    if (byNode?.has(node)) return byNode.get(node);
    const result = computeLexicalFor(node, env);
    if (!byNode) lexicalCache.set(env, (byNode = new WeakMap()));
    byNode.set(node, result);
    return result;
  }
  internEnv.relevantEnvironment = relevantEnvironment;
  internEnv.lexicalEnvironment = lexicalFor;
  internEnv.freeParameters = freeParameters;
  internEnv.isCanonical = (env) => env === EMPTY_ENV || canonical.has(env);
  internEnv.resetFramePool = () => {
    frames.clear();
    previousFrames.clear();
    relevantCache = new WeakMap();
    lexicalCache = new WeakMap();
    normalizedBounds = new WeakSet();
    boundKeys = new WeakMap();
  };
  return internEnv;
}

const lexicalAncestors = new WeakMap(),
  EMPTY_SCOPES = new Set();

export function enclosingScopes(node) {
  if (!node) return EMPTY_SCOPES;
  let scopes = lexicalAncestors.get(node);
  if (!scopes) {
    let nearestFn = node;
    while (nearestFn && !ts.isFunctionLike(nearestFn)) nearestFn = nearestFn.parent;
    if (!nearestFn) scopes = EMPTY_SCOPES;
    else if (nearestFn !== node) scopes = enclosingScopes(nearestFn);
    else {
      const parentScopes = enclosingScopes(nearestFn.parent);
      scopes = new Set(parentScopes);
      scopes.add(nearestFn);
    }
    lexicalAncestors.set(node, scopes);
  }
  return scopes;
}

/** A closure captures only referenced ancestors, never its own prior invocation parameters. */
export function lexicalEnvironment(node, env = EMPTY_ENV) {
  if (env.size === 0) return EMPTY_ENV;
  return environmentInterners.get(node.getSourceFile()).lexicalEnvironment(node, env);
}

/**
 * An environment maps a parameter node to the argument expression evaluated in its caller's env.
 * Callers inside the evaluator pass argument records so a rest binding can retain the original
 * expression frame while it is forwarded through another spread call.
 */
export function bindArguments(
  fn,
  args,
  callerEnv,
  env = fn.env,
  interner = environmentInterners.get(fn.node.getSourceFile()),
) {
  const parameters = interner.freeParameters(fn.node);
  if (parameters.size === 0) return EMPTY_ENV;
  const captured = env.size === 0 ? EMPTY_ENV : interner.lexicalEnvironment(fn.node, env);
  const fnParams = fn.node.parameters;
  if (fnParams.length === 0) return captured;
  let needsBinding = false;
  for (let i = 0; i < fnParams.length; i++) {
    if (parameters.has(fnParams[i])) {
      needsBinding = true;
      break;
    }
  }
  if (!needsBinding) return captured;
  callerEnv = interner(callerEnv);
  const next = new Map(captured);
  let hasRest = false;
  for (let i = 0; i < fnParams.length; i++) {
    if (fnParams[i].dotDotDotToken) {
      hasRest = true;
      break;
    }
  }
  const entries = hasRest
    ? args.map((argument) =>
        argument?.flowArgument ? argument : { flowArgument: true, expression: argument, env: callerEnv },
      )
    : null;
  let mutated = false;
  for (let index = 0; index < fnParams.length; index++) {
    const parameter = fnParams[index];
    if (!parameters.has(parameter)) continue;
    if (parameter.dotDotDotToken) {
      next.set(parameter, { rest: entries.slice(index), env: EMPTY_ENV });
      mutated = true;
      continue;
    }
    const rawArg = args[index];
    const argument = hasRest
      ? entries[index]
      : index < args.length
        ? rawArg?.flowArgument
          ? rawArg
          : { flowArgument: true, expression: rawArg, env: callerEnv }
        : undefined;
    if (argument?.root || argument?.rest) {
      next.set(parameter, argument);
      mutated = true;
      continue;
    }
    const expression = argument?.expression ?? parameter.initializer;
    if (expression) {
      next.set(parameter, {
        expression,
        env: argument ? argument.env : captured,
      });
      mutated = true;
    }
  }
  if (!mutated) return captured;
  return interner(next);
}
