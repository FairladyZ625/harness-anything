#!/usr/bin/env node
/**
 * Deterministic architectural analyzer for duplicate CLI / `*gui*` protocol glue
 * across daemon, CLI, GUI API/preload/browser, and Kernel ActionDeclarations,
 * plus browser streaming parity gaps (ARCH-006 / ARCH-016).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const COMMAND_HELPERS = new Set([
  "defineCliCommand",
  "defineRepoReadCommand",
  "defineEdgeReplicaQueryOnlyReadCommand",
  "defineLedgerWriteCommand",
  "defineCenterForwardWriteCommand",
  "defineLocalArbiterCommand",
]);

const KERNEL_DECLARATION_HELPERS = new Set(["canonical", "closure", "declare", "runtimeAdmin"]);

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function listTsFiles(rootDir, relDir) {
  const fullDir = path.join(rootDir, relDir);
  if (!existsSync(fullDir)) return [];
  const results = [];
  const stack = [fullDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && /\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name)) {
        results.push(toPosix(path.relative(rootDir, fullPath)));
      }
    }
  }
  return results.sort();
}

function readSource(rootDir, relPath) {
  const fullPath = path.join(rootDir, relPath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, "utf8");
  return ts.createSourceFile(fullPath, content, ts.ScriptTarget.Latest, true);
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  if (
    current &&
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.expression.getText() === "Object" &&
    current.expression.name.text === "freeze" &&
    current.arguments[0]
  ) {
    return unwrapExpression(current.arguments[0]);
  }
  return current;
}

function stringValue(node) {
  const inner = unwrapExpression(node);
  if (!inner) return undefined;
  if (ts.isStringLiteralLike(inner)) return inner.text;
  return undefined;
}

function booleanValue(node) {
  const inner = unwrapExpression(node);
  if (!inner) return undefined;
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function stringArrayValue(node) {
  const inner = unwrapExpression(node);
  if (!inner || !ts.isArrayLiteralExpression(inner)) return undefined;
  const items = [];
  for (const el of inner.elements) {
    const val = stringValue(el);
    if (val === undefined) return undefined;
    items.push(val);
  }
  return items;
}

function objectProps(obj) {
  const map = new Map();
  if (!obj || !ts.isObjectLiteralExpression(obj)) return map;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
      if (name) map.set(name, prop.initializer);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      map.set(prop.name.text, prop.name);
    }
  }
  return map;
}

function extractKernelActions(rootDir) {
  const actionDeclPath = "packages/kernel/src/domain/action-declaration.ts";
  const sf = readSource(rootDir, actionDeclPath);
  const actions = [];
  if (sf) {
    visit(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const helper = node.expression.text;
      if (!KERNEL_DECLARATION_HELPERS.has(helper)) return;
      const args = node.arguments;
      const kind = stringValue(args[0]);
      if (!kind) return;
      let catalogId = null;
      let executionClass = null;
      if (helper === "canonical") {
        catalogId = stringValue(args[1]) ?? null;
        executionClass = stringValue(args[2]) ?? null;
      } else if (helper === "closure") {
        catalogId = stringValue(args[1]) ?? null;
        executionClass = "repo-write";
      } else if (helper === "declare") {
        executionClass = stringValue(args[1]) ?? null;
      } else if (helper === "runtimeAdmin") {
        catalogId = stringValue(args[1]) ?? null;
        executionClass = "admin";
      }
      actions.push({ kind, catalogId, executionClass, sourceFile: actionDeclPath });
    });
  }

  const todoDeclPath = "packages/kernel/src/domain/todo-action-contract.ts";
  const todoSf = readSource(rootDir, todoDeclPath);
  const todoDefinitions = [];
  if (todoSf) {
    visit(todoSf, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "todoActionDefinitions")
        return;
      const init = unwrapExpression(node.initializer);
      if (!init || !ts.isArrayLiteralExpression(init)) return;
      for (const el of init.elements) {
        const props = objectProps(unwrapExpression(el));
        const id = stringValue(props.get("id"));
        if (!id) continue;
        const read = booleanValue(props.get("read")) ?? false;
        todoDefinitions.push({
          id,
          actionKind: `todo-${id}`,
          read,
          sourceFile: todoDeclPath,
        });
      }
    });
  }

  const generatedPath = "packages/preset/src/task-action-projection.generated.ts";
  const genSf = readSource(rootDir, generatedPath);
  const generatedTaskActions = [];
  if (genSf) {
    visit(genSf, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const props = objectProps(node);
      const id = stringValue(props.get("id"));
      const executionNode = props.get("execution");
      if (!id || !executionNode || !ts.isObjectLiteralExpression(executionNode)) return;
      const execProps = objectProps(executionNode);
      const ingress = stringValue(execProps.get("ingress"));
      const method = stringValue(execProps.get("method"));
      if (ingress) {
        generatedTaskActions.push({
          id,
          ingress,
          method: method ?? "repo.task.run",
          sourceFile: generatedPath,
        });
      }
    });
  }

  return {
    actions: actions.sort((a, b) => a.kind.localeCompare(b.kind)),
    todoDefinitions: todoDefinitions.sort((a, b) => a.actionKind.localeCompare(b.actionKind)),
    generatedTaskActions: generatedTaskActions.sort((a, b) => a.ingress.localeCompare(b.ingress)),
  };
}

function extractCliCommands(rootDir, commandFiles, todoDefinitions, generatedTaskActions) {
  const byKey = new Map();
  for (const relPath of commandFiles) {
    const sf = readSource(rootDir, relPath);
    if (!sf) continue;
    visit(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      if (!COMMAND_HELPERS.has(node.expression.text)) return;
      const props = objectProps(node.arguments[0]);
      const id = stringValue(props.get("id"));
      if (!id) return;
      const actionKind = stringValue(props.get("actionKind")) ?? id;
      const method = stringValue(props.get("method")) ?? null;
      const cmdPath = stringArrayValue(props.get("path")) ?? null;
      byKey.set(`${relPath}:${id}`, { id, actionKind, method, path: cmdPath, sourceFile: relPath });
    });
  }

  const todoCommandFile = "packages/daemon/src/protocol/daemon-protocol-commands-todo.ts";
  if (existsSync(path.join(rootDir, todoCommandFile))) {
    for (const todo of todoDefinitions) {
      byKey.set(`${todoCommandFile}:${todo.actionKind}`, {
        id: todo.actionKind,
        actionKind: todo.actionKind,
        method: todo.read ? "repo.task.read" : "repo.task.run",
        path: ["todo", todo.id],
        sourceFile: todoCommandFile,
      });
    }
  }

  const taskCommandFile = "packages/daemon/src/protocol/daemon-protocol-commands-task.ts";
  if (existsSync(path.join(rootDir, taskCommandFile))) {
    for (const action of generatedTaskActions) {
      byKey.set(`${taskCommandFile}:${action.ingress}`, {
        id: action.ingress,
        actionKind: action.ingress,
        method: action.method,
        path: ["task", action.id],
        sourceFile: taskCommandFile,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id) || a.sourceFile.localeCompare(b.sourceFile));
}

function parseGuiActionCall(node, helperName, sourceFile) {
  const args = node.arguments;
  const id = stringValue(args[0]);
  const method = stringValue(args[1]);
  const actionKind = stringValue(args[2]);
  const guiBridgeMethod = stringValue(args[4]) ?? null;
  const httpPath = stringValue(args[5]) ?? null;
  const commandClass = stringValue(args[6]) ?? null;
  if (!id || !method || !actionKind) return null;
  return {
    id,
    method,
    kind: "action",
    actionKind,
    guiBridgeMethod,
    httpMethod: "POST",
    httpPath,
    serviceMethod: guiBridgeMethod,
    commandClass,
    helper: helperName,
    sourceFile,
  };
}

function classifyFacetKind(varName, method, relPath) {
  if (varName === "daemonStreamFacets" || varName === "daemonGuiStreamFacets") return "stream";
  if (varName === "providerMethods") return "provider";
  if (varName === "runtimeInstanceMethods" || varName === "runtimeInstanceAuthMethods") return "runtime-instance";
  if (varName.includes("Read") || relPath.includes("read")) return "read";
  if (method.startsWith("repo.") || method.startsWith("daemon.")) return "action";
  return "action";
}

function extractGuiFacets(rootDir, protocolFiles) {
  const facets = [];
  const seen = new Set();
  const targetFiles = protocolFiles.filter((f) => f.includes("gui") || f.endsWith("observe-tail-read.ts"));

  for (const relPath of targetFiles) {
    const sf = readSource(rootDir, relPath);
    if (!sf) continue;

    visit(sf, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === "guiAction" || name === "guiS3Action") {
          const parsed = parseGuiActionCall(node, name, relPath);
          if (parsed && !seen.has(`${relPath}:${parsed.method}:${parsed.id}`)) {
            seen.add(`${relPath}:${parsed.method}:${parsed.id}`);
            facets.push(parsed);
          }
          return;
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const varName = node.name.text;
        const allowedVars = new Set([
          "daemonGuiReadMethods",
          "daemonGuiActionMethods",
          "daemonStreamFacets",
          "runtimeInstanceMethods",
          "runtimeInstanceAuthMethods",
          "providerMethods",
          "observeTailReadMethod",
        ]);
        if (!allowedVars.has(varName)) return;
        visit(node.initializer, (child) => {
          if (!ts.isObjectLiteralExpression(child)) return;
          const props = objectProps(child);
          const id = stringValue(props.get("id"));
          const method = stringValue(props.get("method"));
          if (!id || !method) return;
          const key = `${relPath}:${varName}:${method}:${id}`;
          if (seen.has(key)) return;
          seen.add(key);
          facets.push({
            id,
            method,
            kind: classifyFacetKind(varName, method, relPath),
            actionKind: stringValue(props.get("actionKind")) ?? null,
            guiBridgeMethod: stringValue(props.get("guiBridgeMethod")) ?? null,
            httpMethod: stringValue(props.get("httpMethod")) ?? null,
            httpPath: stringValue(props.get("path")) ?? null,
            serviceMethod: stringValue(props.get("serviceMethod")) ?? null,
            commandClass: stringValue(props.get("commandClass")) ?? null,
            eventMethod: stringValue(props.get("eventMethod")) ?? null,
            helper: varName,
            sourceFile: relPath,
          });
        });
      }
    });
  }

  return facets.sort((a, b) => a.method.localeCompare(b.method) || a.id.localeCompare(b.id));
}

function extractGuiGlueLayers(rootDir) {
  const apiContractRegistry = "packages/gui/src/api/api-contract-registry.ts";
  const serviceBridge = "packages/gui/src/api/service-bridge.ts";
  const preloadAllowlist = "packages/gui/src/preload/allowlist.ts";
  const preloadElectron = "packages/gui/src/preload/electron-preload.ts";
  const preloadRuntime = "packages/gui/src/preload/agent-runtime-preload.ts";
  const browserTransport = "packages/gui/src/browser/browser-gui-transport.ts";
  const browserBroker = "packages/cli/src/cli/gui-browser-broker.ts";

  const apiRegistrySf = readSource(rootDir, apiContractRegistry);
  const serviceBridgeSf = readSource(rootDir, serviceBridge);
  const allowlistSf = readSource(rootDir, preloadAllowlist);
  const electronPreloadSf = readSource(rootDir, preloadElectron);
  const runtimePreloadSf = readSource(rootDir, preloadRuntime);
  const browserTransportSf = readSource(rootDir, browserTransport);
  const browserBrokerSf = readSource(rootDir, browserBroker);

  const apiDerivedFromGuiFacets = Boolean(
    apiRegistrySf &&
      apiRegistrySf.text.includes("daemonGuiReadMethods") &&
      apiRegistrySf.text.includes("daemonGuiActionMethods"),
  );
  const serviceBridgeDerived = Boolean(serviceBridgeSf && serviceBridgeSf.text.includes("daemonGuiInvokeFacets"));
  const preloadAllowlistDerived = Boolean(
    allowlistSf &&
      allowlistSf.text.includes("daemonGuiInvokeFacets") &&
      allowlistSf.text.includes("daemonGuiStreamFacets"),
  );
  const electronPreloadExposesStreams = Boolean(
    electronPreloadSf && electronPreloadSf.text.includes("daemonGuiStreamFacets"),
  );
  const runtimePreloadStreamBindings = [];
  if (runtimePreloadSf) {
    const match = runtimePreloadSf.text.match(/repo\.[A-Za-z0-9_.]+/gu) ?? [];
    for (const item of new Set(match)) runtimePreloadStreamBindings.push(item);
  }

  let browserStreamStatus = null;
  let browserStreamReason = null;
  if (browserTransportSf) {
    const localConsts = new Map();
    visit(browserTransportSf, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrapExpression(node.initializer);
        if (init && ts.isObjectLiteralExpression(init)) {
          localConsts.set(node.name.text, init);
        }
      }
    });
    visit(browserTransportSf, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const props = objectProps(node);
      if (!props.has("stream")) return;
      let streamObj = unwrapExpression(props.get("stream"));
      if (streamObj && ts.isIdentifier(streamObj) && localConsts.has(streamObj.text)) {
        streamObj = localConsts.get(streamObj.text);
      }
      if (streamObj && ts.isObjectLiteralExpression(streamObj)) {
        const sp = objectProps(streamObj);
        browserStreamStatus = stringValue(sp.get("status")) ?? browserStreamStatus;
        browserStreamReason = stringValue(sp.get("reason")) ?? browserStreamReason;
      }
    });
  }

  let brokerRpcOnly = false;
  let brokerAllowsRead = false;
  let brokerAllowsAction = false;
  let brokerHasStreamHandler = false;
  if (browserBrokerSf) {
    const text = browserBrokerSf.text;
    brokerRpcOnly = text.includes('"/rpc"');
    brokerAllowsRead = text.includes("isDaemonGuiReadMethod");
    brokerAllowsAction = text.includes("isDaemonGuiActionMethod");
    brokerHasStreamHandler =
      text.includes("isDaemonStream") ||
      text.includes("text/event-stream") ||
      text.includes("WebSocketServer") ||
      text.includes('"/stream"');
  }

  const guiApiContracts = listTsFiles(rootDir, "packages/gui/src/api").filter((f) => f.endsWith("-contract.ts"));

  return {
    apiDerivedFromGuiFacets,
    serviceBridgeDerived,
    preloadAllowlistDerived,
    electronPreloadExposesStreams,
    runtimePreloadStreamBindings: runtimePreloadStreamBindings.sort(),
    guiApiContracts,
    browserTransport: {
      file: browserTransport,
      exists: browserTransportSf !== null,
      streamCapabilityStatus: browserStreamStatus,
      streamCapabilityReason: browserStreamReason,
      hasStreamingClient: Boolean(
        browserTransportSf &&
          (browserTransportSf.text.includes("EventSource") ||
            browserTransportSf.text.includes("WebSocket") ||
            browserTransportSf.text.includes("stream(")),
      ),
    },
    browserBroker: {
      file: browserBroker,
      exists: browserBrokerSf !== null,
      rpcPostEndpoint: brokerRpcOnly,
      allowsGuiReads: brokerAllowsRead,
      allowsGuiActions: brokerAllowsAction,
      hasStreamHandler: brokerHasStreamHandler,
    },
  };
}

function buildDuplicateGlueEntries(kernelActions, cliCommands, guiFacets, layers) {
  const kernelByKind = new Map(kernelActions.map((a) => [a.kind, a]));
  const cliByActionKind = new Map();
  for (const cmd of cliCommands) {
    if (!cliByActionKind.has(cmd.actionKind)) cliByActionKind.set(cmd.actionKind, []);
    cliByActionKind.get(cmd.actionKind).push(cmd);
  }

  const duplicateCliGuiGlue = [];
  const guiOnlyFacets = [];

  for (const facet of guiFacets) {
    if (facet.kind === "stream") continue;
    const kernelMatch = facet.actionKind ? kernelByKind.get(facet.actionKind) : undefined;
    const cliMatches = facet.actionKind ? (cliByActionKind.get(facet.actionKind) ?? []) : [];
    const shadowLayers = [];
    if (kernelMatch) shadowLayers.push("kernel.actionDeclaration");
    if (cliMatches.length > 0) shadowLayers.push("daemon.cliCommand");
    shadowLayers.push("daemon.guiFacet");
    if (layers.apiDerivedFromGuiFacets && facet.httpPath) shadowLayers.push("gui.apiContractRegistry");
    if (layers.serviceBridgeDerived && facet.guiBridgeMethod) shadowLayers.push("gui.serviceBridge");
    if (layers.preloadAllowlistDerived && facet.guiBridgeMethod) shadowLayers.push("gui.preloadAllowlist");

    if (kernelMatch || cliMatches.length > 0) {
      duplicateCliGuiGlue.push({
        id: facet.id,
        guiMethod: facet.method,
        actionKind: facet.actionKind,
        cliCommandIds: cliMatches.map((c) => c.id),
        cliRpcMethods: [...new Set(cliMatches.map((c) => c.method).filter(Boolean))],
        guiBridgeMethod: facet.guiBridgeMethod,
        httpMethod: facet.httpMethod,
        httpPath: facet.httpPath,
        commandClass: facet.commandClass ?? kernelMatch?.executionClass ?? null,
        layers: shadowLayers,
        sourceFile: facet.sourceFile,
      });
    } else if (facet.guiBridgeMethod || facet.helper.startsWith("daemonGui")) {
      guiOnlyFacets.push({
        id: facet.id,
        guiMethod: facet.method,
        kind: facet.kind,
        guiBridgeMethod: facet.guiBridgeMethod,
        httpMethod: facet.httpMethod,
        httpPath: facet.httpPath,
        layers: shadowLayers,
        sourceFile: facet.sourceFile,
      });
    }
  }

  duplicateCliGuiGlue.sort((a, b) => a.id.localeCompare(b.id) || a.guiMethod.localeCompare(b.guiMethod));
  guiOnlyFacets.sort((a, b) => a.id.localeCompare(b.id) || a.guiMethod.localeCompare(b.guiMethod));
  return { duplicateCliGuiGlue, guiOnlyFacets };
}

function buildStreamingGaps(guiFacets, layers) {
  const daemonStreams = guiFacets.filter((f) => f.kind === "stream");
  const gaps = [];

  for (const stream of daemonStreams) {
    if (!stream.guiBridgeMethod) {
      gaps.push({
        id: `stream-facet-missing-gui-bridge:${stream.method}`,
        archRefs: ["ARCH-006", "ARCH-016"],
        severity: "high",
        file: stream.sourceFile,
        detail: `${stream.method} is declared in daemonStreamFacets (event=${stream.eventMethod ?? "unknown"}) without a guiBridgeMethod/daemonGuiStreamFacets exposure; GUI renderer falls back to cursor polling instead of push streaming.`,
      });
    }
  }

  if (layers.browserTransport.exists && layers.browserTransport.streamCapabilityStatus === "unavailable") {
    gaps.push({
      id: "browser-transport-stream-unavailable",
      archRefs: ["ARCH-006", "ARCH-016"],
      severity: "high",
      file: layers.browserTransport.file,
      detail: `Browser transport hardcodes capabilities().stream.status = "unavailable" ("${layers.browserTransport.streamCapabilityReason ?? ""}") and implements no WebSocket/SSE stream client.`,
    });
  }

  if (layers.browserBroker.exists && layers.browserBroker.rpcPostEndpoint && !layers.browserBroker.hasStreamHandler) {
    gaps.push({
      id: "browser-broker-rpc-post-only",
      archRefs: ["ARCH-006", "ARCH-016"],
      severity: "high",
      file: layers.browserBroker.file,
      detail:
        "CLI browser broker only serves POST /rpc for isDaemonGuiReadMethod/isDaemonGuiActionMethod and has no WebSocket or SSE streaming upgrade/endpoint.",
    });
  }

  for (const stream of daemonStreams.filter((s) => Boolean(s.guiBridgeMethod))) {
    if (layers.browserTransport.exists && !layers.browserTransport.hasStreamingClient) {
      gaps.push({
        id: `browser-parity-missing-stream:${stream.method}`,
        archRefs: ["ARCH-006", "ARCH-016"],
        severity: "medium",
        file: layers.browserTransport.file,
        detail: `Electron exposes ${stream.guiBridgeMethod} (${stream.method}) via preload/IPC, while browser transport has no streaming handler for ${stream.method}.`,
      });
    }
  }

  return {
    daemonStreams,
    preloadStreamBindings: layers.runtimePreloadStreamBindings,
    browserTransport: layers.browserTransport,
    browserBroker: layers.browserBroker,
    gaps: gaps.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function analyzeProtocolSurface(rootDir = process.cwd()) {
  const protocolFiles = listTsFiles(rootDir, "packages/daemon/src/protocol");
  const guiShadowFiles = protocolFiles.filter((f) => path.basename(f).includes("gui"));
  const cliCommandFiles = protocolFiles.filter((f) => path.basename(f).startsWith("daemon-protocol-commands"));
  const presetFiles = existsSync(path.join(rootDir, "packages/preset/src/preset-command-contract.ts"))
    ? ["packages/preset/src/preset-command-contract.ts"]
    : [];

  const kernel = extractKernelActions(rootDir);
  const cliCommands = extractCliCommands(
    rootDir,
    [...cliCommandFiles, ...presetFiles],
    kernel.todoDefinitions,
    kernel.generatedTaskActions,
  );
  const guiFacets = extractGuiFacets(rootDir, protocolFiles);
  const layers = extractGuiGlueLayers(rootDir);
  const { duplicateCliGuiGlue, guiOnlyFacets } = buildDuplicateGlueEntries(
    kernel.actions,
    cliCommands,
    guiFacets,
    layers,
  );
  const streamingSurface = buildStreamingGaps(guiFacets, layers);

  return {
    schema: "protocol-surface-analysis/v1",
    counts: {
      daemonProtocolFiles: protocolFiles.length,
      daemonGuiShadowFiles: guiShadowFiles.length,
      kernelActionDeclarations: kernel.actions.length,
      kernelTodoActions: kernel.todoDefinitions.length,
      kernelTaskActionGenerated: kernel.generatedTaskActions.length,
      cliCommands: cliCommands.length,
      guiFacetsTotal: guiFacets.length,
      guiActionFacets: guiFacets.filter((f) => f.kind === "action").length,
      guiReadFacets: guiFacets.filter((f) => f.kind === "read").length,
      daemonStreamFacets: streamingSurface.daemonStreams.length,
      guiApiContractFiles: layers.guiApiContracts.length,
      duplicateCliGuiGlue: duplicateCliGuiGlue.length,
      guiOnlyFacets: guiOnlyFacets.length,
      browserStreamingGaps: streamingSurface.gaps.length,
    },
    protocolInventory: {
      daemonProtocolFiles: protocolFiles,
      guiShadowFiles,
      cliCommandFiles,
      guiApiContractFiles: layers.guiApiContracts,
    },
    duplicateCliGuiGlue,
    guiOnlyFacets,
    streamingSurface,
  };
}

function formatSummary(report) {
  const c = report.counts;
  const lines = [
    `Protocol Surface Analysis (${report.schema})`,
    `- Daemon protocol files: ${c.daemonProtocolFiles} (${c.daemonGuiShadowFiles} *gui* shadow files)`,
    `- Kernel actions: ${c.kernelActionDeclarations} canonical + ${c.kernelTaskActionGenerated} task-generated + ${c.kernelTodoActions} todo-actions`,
    `- CLI protocol commands: ${c.cliCommands}`,
    `- GUI facets: ${c.guiFacetsTotal} (${c.guiActionFacets} actions, ${c.guiReadFacets} reads, ${c.daemonStreamFacets} streams)`,
    `- Duplicate CLI/GUI glue entries: ${c.duplicateCliGuiGlue}`,
    `- GUI-only RPC/bridge facets: ${c.guiOnlyFacets}`,
    `- Browser streaming parity gaps (ARCH-006 / ARCH-016): ${c.browserStreamingGaps}`,
    "",
    "Top Duplicate CLI/GUI Glue (sample up to 15):",
    ...report.duplicateCliGuiGlue
      .slice(0, 15)
      .map(
        (d) =>
          `  * ${d.guiMethod} <-> actionKind=${d.actionKind} (cli=${d.cliCommandIds.join(",") || "none"}, bridge=${d.guiBridgeMethod ?? "none"}, layers=${d.layers.length})`,
      ),
    "",
    "Browser Streaming Gaps:",
    ...report.streamingSurface.gaps.map((g) => `  * [${g.severity}] ${g.id} (${g.file}): ${g.detail}`),
  ];
  return lines.join("\n");
}

function parseCliArgs(argv) {
  let rootDir = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--root" && i + 1 < argv.length) {
      rootDir = path.resolve(argv[++i]);
    }
  }
  return { rootDir, json };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { rootDir, json } = parseCliArgs(process.argv.slice(2));
  const report = analyzeProtocolSurface(rootDir);
  console.log(json ? JSON.stringify(report, null, 2) : formatSummary(report));
}
