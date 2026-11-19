// The checker stays with its Program. Workers hold syntax for files they visit and ask
// the owner for immutable type facts. Both ends address authored nodes in source order.
import ts from "typescript";
import { receiveMessageOnPort } from "node:worker_threads";

const methods = [
  "callDeclaration",
  "memberSignature",
  "implementsMember",
  "typeName",
  "propertyAllowsLiteral",
  "takesInterface",
  "interfaceMembers",
  "carriesTransport",
  "uniqueSymbolKey",
  "memberKey",
  "importTarget",
];
function syntaxTable(source) {
  const nodes = [],
    ids = new WeakMap();
  function index(node) {
    ids.set(node, nodes.length);
    nodes.push(node);
    ts.forEachChild(node, index);
    // JS call signatures can be authored inside @param types. The checker
    // returns those declarations, although forEachChild skips attached JSDoc.
    for (const comment of node.jsDoc ?? []) index(comment);
  }
  index(source);
  return { ids, nodes };
}
function translate(value, special) {
  if (!value || typeof value !== "object") return value;
  const item = special(value);
  if (item !== undefined) return item;
  const convert = (v) => translate(v, special);
  if (Array.isArray(value)) return value.map(convert);
  if (value instanceof Set) return new Set([...value].map(convert));
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [convert(k), convert(v)]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
}
function codec(tableFor, fileFor, resolveFile, tokenFor, resolveToken) {
  const encodeNode = (node) => {
    if (tokenFor.has(node)) return { typeToken: tokenFor.get(node) };
    if (typeof node.getSourceFile !== "function") return undefined;
    const file = node.getSourceFile();
    if (!file && ts.isParenthesizedExpression(node))
      return { detachedParenthesis: encodeNode(node.expression), pos: node.pos, end: node.end };
    if (!file && ts.isIdentifier(node)) return { detachedIdentifier: node.text };
    if (!file && ts.isStringLiteralLike(node)) return { detachedString: node.text };
    const ordinal = file && tableFor(file).ids.get(node);
    if (ordinal === undefined) {
      // The policy interpreter constructs property reads when following an object spread.
      if (ts.isPropertyAccessExpression(node) && node.flags & ts.NodeFlags.Synthesized)
        return { derivedMember: node.name.text, receiver: encodeNode(node.expression) };
      throw new Error(
        `unindexed authorization query ${ts.SyntaxKind[node.kind]} flags=${node.flags} in ${file?.fileName ?? "(detached)"} at ${node.pos}`,
      );
    }
    return { file: fileFor(file), ordinal, kind: node.kind, end: node.end };
  };
  const decodeNode = (ref) => {
    if (Object.hasOwn(ref, "typeToken")) return resolveToken(ref.typeToken);
    if (Object.hasOwn(ref, "detachedParenthesis"))
      return ts.setTextRange(ts.factory.createParenthesizedExpression(decodeNode(ref.detachedParenthesis)), ref);
    if (Object.hasOwn(ref, "detachedIdentifier")) return ts.factory.createIdentifier(ref.detachedIdentifier);
    if (Object.hasOwn(ref, "detachedString")) return ts.factory.createStringLiteral(ref.detachedString);
    if (Object.hasOwn(ref, "derivedMember")) {
      const receiver = decodeNode(ref.receiver);
      const node = ts.factory.createPropertyAccessExpression(receiver, ref.derivedMember);
      ts.setTextRange(node, receiver);
      node.parent = receiver.parent;
      return node;
    }
    if (!Object.hasOwn(ref, "ordinal")) return undefined;
    const file = resolveFile(ref.file);
    const node = tableFor(file).nodes[ref.ordinal];
    if (node?.kind !== ref.kind || node.end !== ref.end)
      throw new Error(`authorization syntax index differs in ${file.fileName} at ${ref.ordinal}`);
    return node;
  };
  return { encode: (value) => translate(value, encodeNode), decode: (value) => translate(value, decodeNode) };
}
function cachedTables() {
  const files = new WeakMap();
  return (file) => {
    if (!files.has(file)) files.set(file, syntaxTable(file));
    return files.get(file);
  };
}
export function shareAuthorizationTypes(graph, entries, witnesses) {
  const files = [],
    byFile = new WeakMap(),
    tokens = [],
    tokenIds = new WeakMap();
  const fileId = (file) => {
    if (!byFile.has(file)) {
      byFile.set(file, files.length);
      files.push(file);
    }
    return byFile.get(file);
  };
  const { encode, decode } = codec(
    cachedTables(),
    fileId,
    (id) => files[id],
    tokenIds,
    (id) => tokens[id],
  );
  const sourceData = new Map(),
    counts = new Map();
  function source(id) {
    if (!sourceData.has(id)) {
      const file = files[id],
        bytes = Buffer.from(file.text),
        shared = new SharedArrayBuffer(bytes.length);
      new Uint8Array(shared).set(bytes);
      sourceData.set(id, {
        logical: graph.fileOf(file),
        fileName: file.fileName,
        languageVersion: file.languageVersion,
        jsDocParsingMode: file.jsDocParsingMode,
        scriptKind: file.scriptKind,
        shared,
      });
    }
    return sourceData.get(id);
  }
  const meta = {
    modules: [...graph.modules].map(([file, mod]) => [file, fileId(mod.sourceFile)]),
    entries: encode(entries),
    witnesses: encode(witnesses),
    rootDir: graph.rootDir,
  };
  function serve(port, signal, groupQueue) {
    function sendResult({ method, arguments: encoded }) {
      try {
        if (Atomics.load(groupQueue, 1)) throw new Error("peer worker failed");
        counts.set(method, 1 + (counts.get(method) ?? 0));
        if (method === "source") port.postMessage({ value: source(encoded[0]) });
        else {
          const args = decode(encoded);
          const all = ["members", "memberFiles", "matches"].includes(method) ? (graph.members.get(args[0]) ?? []) : [];
          const value =
            method === "members"
              ? all
              : method === "memberFiles"
                ? [...new Set(all.map((row) => row.file))]
                : method === "matches"
                  ? all.filter(
                      (row) =>
                        args[1].has(row.declaration) || graph.implementsMember(row.declaration, args[0], args[1]),
                    )
                  : graph[method](...args);
          if (
            ["uniqueSymbolKey", "memberKey"].includes(method) &&
            value &&
            typeof value === "object" &&
            !tokenIds.has(value)
          ) {
            tokenIds.set(value, tokens.length);
            tokens.push(value);
          }
          port.postMessage({ value: encode(value) });
        }
      } catch (error) {
        return { error: error.stack ?? String(error) };
      }
    }
    port.on("message", (query) => {
      try {
        const failure = sendResult(query);
        if (failure) port.postMessage(failure);
      } finally {
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
      }
    });
  }
  return { meta, serve, counts };
}
export function readAuthorizationTypes({ meta, port, signal }) {
  const logical = new WeakMap(),
    files = new Map(),
    fileIds = new WeakMap(),
    tokens = new Map(),
    tokenIds = new WeakMap();
  let register;
  function request(method, args) {
    Atomics.store(signal, 0, 0);
    port.postMessage({ method, arguments: args });
    // A notification for the previous reply can arrive after this request
    // clears the flag. Only the owner's store publishes the current reply.
    while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
    const response = receiveMessageOnPort(port)?.message;
    if (!response || response.error) throw new Error(response?.error ?? "missing authorization type response");
    return response.value;
  }
  const source = (id) => {
    if (!files.has(id)) {
      const {
        logical: relative,
        fileName,
        languageVersion,
        jsDocParsingMode,
        scriptKind,
        shared,
      } = request("source", [id]);
      const file = ts.createSourceFile(
        fileName,
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(shared),
        { languageVersion, jsDocParsingMode },
        true,
        scriptKind,
      );
      files.set(id, file);
      logical.set(file, relative);
      fileIds.set(file, id);
      register?.(file);
    }
    return files.get(id);
  };
  const { encode, decode } = codec(
    cachedTables(),
    (file) => fileIds.get(file),
    source,
    tokenIds,
    (id) => {
      if (!tokens.has(id)) {
        const token = {};
        tokens.set(id, token);
        tokenIds.set(token, id);
      }
      return tokens.get(id);
    },
  );
  // Argument identity is local to a worker. Type-derived keys and authored nodes
  // are interned when crossing the port, so the same query reaches one cache leaf.
  function query(method) {
    const cache = new Map();
    return (...args) => {
      let entry = cache;
      for (const arg of args) {
        if (!entry.has(arg)) entry.set(arg, new Map());
        entry = entry.get(arg);
      }
      if (!Object.hasOwn(entry, "value")) {
        try {
          entry.value = decode(request(method, encode(args)));
        } catch (error) {
          throw new Error(`authorization checker query ${method}: ${error.stack ?? error}`);
        }
      }
      return entry.value;
    };
  }
  const paths = new Map(meta.modules.map(([file, id]) => [id, file]));
  const refKey = (ref) => ref && ref.file + ":" + ref.ordinal;
  const nodeKeys = new WeakMap();
  function witnessKeys(files) {
    const included = (id) => {
      const ref = meta.witnesses.get(id);
      return ref && files.has(paths.get(ref.file)) ? ref : undefined;
    };
    return {
      has: (id) => Boolean(included(id)),
      get: (id) => {
        const ref = included(id);
        return ref && decode(ref);
      },
      key: (id) => refKey(included(id)),
      nodeKey: (node) => {
        if (!nodeKeys.has(node)) nodeKeys.set(node, refKey(encode(node)));
        return nodeKeys.get(node);
      },
    };
  }
  const queryMembers = query("members"),
    filesOf = query("memberFiles"),
    matches = query("matches");
  const queries = Object.fromEntries(methods.map((method) => [method, query(method)]));
  const typedKey = queries.memberKey,
    typedImport = queries.importTarget,
    imports = new Map();
  queries.memberKey = (name) =>
    name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name))
      ? name.text
      : typedKey(name);
  queries.importTarget = (binding) => {
    let targets = imports.get(binding.file);
    if (!targets) imports.set(binding.file, (targets = new Map()));
    if (!targets.has(binding.from)) targets.set(binding.from, typedImport({ file: binding.file, from: binding.from }));
    return targets.get(binding.from);
  };
  const members = (include) => {
    const cached = new Map();
    return {
      hasCandidates: (key) => filesOf(key).some((file) => !include || include(file)),
      matching: (key, signatures) => matches(key, signatures).filter((row) => !include || include(row.file)),
      get(key) {
        if (!cached.has(key)) {
          const rows = queryMembers(key);
          cached.set(key, include ? rows?.filter((row) => include(row.file)) : rows);
        }
        return cached.get(key);
      },
    };
  };
  return {
    fileOf: (node) => {
      const file = node.getSourceFile();
      return logical.get(file) ?? file.fileName;
    },
    queries,
    modules: new Map(meta.modules.map(([file, id]) => [file, () => source(id)])),
    members: members(),
    projectMembers: members,
    witnessKeys,
    entries: () => decode(meta.entries),
    witness: (id) => {
      const ref = meta.witnesses.get(id);
      return ref && decode(ref);
    },
    register(owner) {
      register = owner;
      for (const file of files.values()) register(file);
    },
    release() {
      register = undefined;
      port.close();
    },
  };
}
