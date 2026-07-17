// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateApiContractRegistry } from "./check-api-contract-registry.mjs";

test("API contract registry accepts the repository route registry", () => {
  assert.deepEqual(evaluateApiContractRegistry(), []);
});

test("API contract registry rejects removal of the canonical daemon status route", async () => {
  await withDaemonFixtureRepo(async (root) => {
    replaceFixtureText(root, "packages/gui/src/api/api-contract-registry.ts", "id: \"daemon.status\"", "id: \"daemon.status.removed\"");
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("missing required daemon.status route")), true);
  });
});

test("API contract registry rejects missing daemon status fixtures", async () => {
  await withDaemonFixtureRepo(async (root) => {
    rmSync(path.join(root, "packages/daemon/fixtures/api-schemas/daemon.status-result__v2/invalid.json"));
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("daemon.status-result/v2 missing fixture")), true);
  });
});

test("API contract registry rejects disconnected daemon status handlers", async () => {
  await withDaemonFixtureRepo(async (root) => {
    replaceFixtureText(root, "packages/daemon/src/protocol/json-rpc-server.ts", "services.DaemonStatusService.getStatus", "services.DaemonStatusService.disconnectedStatus");
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("services.DaemonStatusService.getStatus")), true);
  });
});

test("API contract registry rejects removal of the canonical daemon logs route", async () => {
  await withDaemonFixtureRepo(async (root) => {
    replaceFixtureText(root, "packages/gui/src/api/api-contract-registry.ts", "id: \"daemon.logs.list\"", "id: \"daemon.logs.removed\"");
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("missing required daemon.logs.list route")), true);
  });
});

test("API contract registry rejects missing daemon log schema fixtures", async () => {
  await withDaemonFixtureRepo(async (root) => {
    rmSync(path.join(root, "packages/daemon/fixtures/api-schemas/daemon-log-page__v1/invalid.json"));
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("daemon-log-page/v1 missing fixture")), true);
  });
});

test("API contract registry rejects disconnected daemon log handlers", async () => {
  await withDaemonFixtureRepo(async (root) => {
    replaceFixtureText(root, "packages/daemon/src/protocol/daemon-log-dispatch.ts", "service.list", "service.disconnectedList");
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("services.DaemonLogService.list")), true);
  });
});

test("API contract registry rejects daemon admin command-class drift", async () => {
  await withDaemonFixtureRepo(async (root) => {
    const relativePath = "packages/daemon/src/protocol/method-registry.ts";
    const absolutePath = path.join(root, relativePath);
    const source = readFileSync(absolutePath, "utf8");
    const start = source.indexOf('method: "admin.daemon.restart"');
    const changed = source.slice(0, start) + source.slice(start).replace('commandClass: "admin"', 'commandClass: "repo-write"');
    writeFileSync(absolutePath, changed, "utf8");
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("admin.daemon.restart") && violation.includes("commandClass")), true);
  });
});

test("API contract registry rejects owner identity in the renderer projection", async () => {
  await withDaemonFixtureRepo(async (root) => {
    replaceFixtureText(
      root,
      "packages/application/src/daemon-status-contract.ts",
      "lock: { path: repo.lock.path }",
      "lock: { path: repo.lock.path, ownerToken: repo.lock.ownerToken }"
    );
    assert.equal(evaluateApiContractRegistry(root).some((violation) => violation.includes("path only")), true);
  });
});

test("API contract registry accepts task write routes projected from application policy", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [],
      taskWritePolicyEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })]
    });

    assert.deepEqual(evaluateApiContractRegistry(root), []);
  });
});

test("API contract registry rejects preload methods missing from registry", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "getTaskDetail"],
      handlerMethods: ["getTasks", "getTaskDetail"],
      serviceMethods: ["getTasks", "getTaskDetail"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("getTaskDetail") && violation.includes("preload allowlist")), true);
  });
});

test("API contract registry rejects registry-derived preload projection", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      registryDerivedPreload: true,
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("real preload API surface")), true);
    assert.equal(violations.some((violation) => violation.includes("real preload API metadata")), true);
  });
});

test("API contract registry rejects routes pointing at missing service methods", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ serviceMethod: "missingMethod" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("missing LocalControllerService.missingMethod")), true);
  });
});

test("API contract registry rejects duplicate method and path pairs", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "getTaskDetail"],
      handlerMethods: ["getTasks", "getTaskDetail"],
      serviceMethods: ["getTasks", "getTaskDetail"],
      registryEntries: [
        route({ id: "tasks.list", guiBridgeMethod: "getTasks", serviceMethod: "getTasks" }),
        route({ id: "tasks.detail", guiBridgeMethod: "getTaskDetail", serviceMethod: "getTaskDetail" })
      ]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("duplicate route method/path GET /api/tasks")), true);
  });
});

test("API contract registry rejects duplicate active GUI bridge methods", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks", "getTaskDetail"],
      registryEntries: [
        route({ id: "tasks.list", path: "/api/tasks", guiBridgeMethod: "getTasks", serviceMethod: "getTasks" }),
        route({ id: "tasks.alias", path: "/api/task-alias", guiBridgeMethod: "getTasks", serviceMethod: "getTaskDetail" })
      ]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("duplicate active guiBridgeMethod getTasks")), true);
  });
});

test("API contract registry rejects malformed schema ids and unimplemented bridge methods", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: [],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ inputSchemaId: "TaskListResult", guiBridgeMethod: "getTasks" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("malformed inputSchemaId")), true);
    assert.equal(violations.some((violation) => violation.includes("active API registry GUI bridge methods")), true);
  });
});

test("API contract registry rejects valid-looking but unregistered schema ids", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ inputSchemaId: "application.not-real/v1" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("application.not-real/v1") && violation.includes("not registered")), true);
  });
});

test("API contract registry rejects bridge handler implementations calling the wrong service method", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerImplementations: [{ method: "getTasks", serviceMethod: "getTaskDetail" }],
      serviceMethods: ["getTasks", "getTaskDetail"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("getTasks shipped bridge handler declares getTaskDetail")), true);
    assert.equal(violations.some((violation) => violation.includes("getTasks shipped bridge handler does not call LocalControllerService.getTasks")), true);
    assert.equal(violations.some((violation) => violation.includes("getTasks shipped bridge handler calls unexpected LocalControllerService.getTaskDetail")), true);
  });
});

test("API contract registry rejects duplicate bridge handler implementations", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerImplementations: [
        { method: "getTasks", serviceMethod: "getTaskDetail" },
        { method: "getTasks", serviceMethod: "getTasks" }
      ],
      serviceMethods: ["getTasks", "getTaskDetail"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("duplicate GUI bridge handler implementation for getTasks")), true);
    assert.equal(violations.some((violation) => violation.includes("getTasks shipped bridge handler does not call LocalControllerService.getTasks")), true);
  });
});

test("API contract registry covers deferred GUI bridge methods without active routes", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "archiveTask"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks", "archiveTask"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      deferredEntries: [{
        guiBridgeMethod: "archiveTask",
        service: "LocalControllerService",
        serviceMethod: "archiveTask",
        reason: "Archive is disabled until route ownership lands."
      }]
    });

    assert.deepEqual(evaluateApiContractRegistry(root), []);
  });
});

test("API contract registry rejects active route methods marked as deferred capabilities", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      preloadCapabilities: {
        getTasks: { method: "getTasks", status: "deferred", reason: "wrongly deferred" }
      },
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("getTasks must be marked shipped")), true);
  });
});

test("API contract registry rejects deferred bridge methods marked as shipped capabilities", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "archiveTask"],
      preloadCapabilities: {
        getTasks: { method: "getTasks", status: "shipped" },
        archiveTask: { method: "archiveTask", status: "shipped" }
      },
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks", "archiveTask"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      deferredEntries: [{
        guiBridgeMethod: "archiveTask",
        service: "LocalControllerService",
        serviceMethod: "archiveTask",
        reason: "Archive is disabled until route ownership lands."
      }]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("deferred archiveTask must be marked deferred")), true);
  });
});

test("API contract registry rejects preload methods without capability metadata", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "getTaskDetail"],
      preloadCapabilities: {
        getTasks: { method: "getTasks", status: "shipped" }
      },
      handlerMethods: ["getTasks", "getTaskDetail"],
      serviceMethods: ["getTasks", "getTaskDetail"],
      registryEntries: [
        route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" }),
        route({ id: "tasks.detail", guiBridgeMethod: "getTaskDetail", serviceMethod: "getTaskDetail" })
      ]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("getTaskDetail") && violation.includes("preload capability metadata")), true);
  });
});

test("API contract registry rejects deferred capability without reason", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "archiveTask"],
      preloadCapabilities: {
        getTasks: { method: "getTasks", status: "shipped" },
        archiveTask: { method: "archiveTask", status: "deferred" }
      },
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks", "archiveTask"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      deferredEntries: [{
        guiBridgeMethod: "archiveTask",
        service: "LocalControllerService",
        serviceMethod: "archiveTask",
        reason: "Archive is disabled until route ownership lands."
      }]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("archiveTask deferred status requires reason")), true);
  });
});

test("API contract registry rejects deferred bridge methods in shipped handler implementations", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks", "archiveTask"],
      handlerMethods: ["getTasks", "archiveTask"],
      serviceMethods: ["getTasks", "archiveTask"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      deferredEntries: [{
        guiBridgeMethod: "archiveTask",
        service: "LocalControllerService",
        serviceMethod: "archiveTask",
        reason: "Archive is disabled until route ownership lands."
      }]
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("deferred archiveTask must not appear in GUI shipped bridge handler implementations")), true);
  });
});

test("API contract registry accepts terminal service routes without preload dispatch", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      terminalRoutes: requiredTerminalRoutes()
    });

    assert.deepEqual(evaluateApiContractRegistry(root), []);
  });
});

test("API contract registry rejects terminal routes pointing at missing terminal service methods", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      terminalMethods: ["createSession", "listSessions", "getSession", "attachSession", "resizeSession", "closeSession"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      terminalRoutes: requiredTerminalRoutes().map((entry) => entry.id === "terminal.sessions.list"
        ? { ...entry, serviceMethod: "missingTerminalMethod" }
        : entry)
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("missing TerminalSessionService.missingTerminalMethod")), true);
  });
});

test("API contract registry rejects missing required terminal routes", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      terminalRoutes: requiredTerminalRoutes().filter((entry) => entry.id !== "terminal.sessions.attach")
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("missing required terminal route terminal.sessions.attach")), true);
  });
});

test("API contract registry rejects required terminal route path drift", async () => {
  await withFixtureRepo(async (root) => {
    writeFixture(root, {
      preloadMethods: ["getTasks"],
      handlerMethods: ["getTasks"],
      serviceMethods: ["getTasks"],
      registryEntries: [route({ guiBridgeMethod: "getTasks", serviceMethod: "getTasks" })],
      terminalRoutes: requiredTerminalRoutes().map((entry) => entry.id === "terminal.sessions.get"
        ? { ...entry, path: "/api/terminal/sessions/:sessionId" }
        : entry)
    });

    const violations = evaluateApiContractRegistry(root);

    assert.equal(violations.some((violation) => violation.includes("terminal route terminal.sessions.get path must be /api/terminal/sessions/:id")), true);
  });
});

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-api-registry-"));
  try {
    mkdirSync(path.join(root, "packages/gui/src/api"), { recursive: true });
    mkdirSync(path.join(root, "packages/gui/src/preload"), { recursive: true });
    mkdirSync(path.join(root, "packages/gui/src/terminal"), { recursive: true });
    mkdirSync(path.join(root, "packages/application/src"), { recursive: true });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withDaemonFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-api-daemon-registry-"));
  const paths = [
    "packages/gui/src/api/api-contract-registry.ts",
    "packages/gui/src/api/service-bridge.ts",
    "packages/gui/src/preload/allowlist.ts",
    "packages/gui/src/terminal/session-registry.ts",
    "packages/application/src/index.ts",
    "packages/application/src/daemon-status-contract.ts",
    "packages/application/src/daemon-log-contract.ts",
    "packages/application/src/task-write-route-policy.ts",
    "packages/daemon/src/protocol/method-registry.ts",
    "packages/daemon/src/protocol/json-rpc-server.ts",
    "packages/daemon/src/protocol/daemon-log-dispatch.ts",
    "packages/daemon/src/transport/json-rpc-stream.ts",
    "packages/daemon/fixtures/api-schemas",
    "packages/daemon/fixtures/daemon-control"
  ];
  try {
    for (const relativePath of paths) {
      const destination = path.join(root, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.resolve(relativePath), destination, { recursive: true });
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function replaceFixtureText(root, relativePath, before, after) {
  const absolutePath = path.join(root, relativePath);
  const source = readFileSync(absolutePath, "utf8");
  assert.equal(source.includes(before), true, `${relativePath} missing replacement anchor`);
  writeFileSync(absolutePath, source.replace(before, after), "utf8");
}

function writeFixture(root, options) {
  const schemaContracts = options.schemaContracts ?? [
    { id: "gui.empty/v1", owner: "gui", typeName: "EmptyGuiPayload" },
    { id: "application.local-controller-error/v1", owner: "application", typeName: "LocalControllerError" },
    { id: "application.task-list-result/v1", owner: "application", typeName: "TaskListResult" },
    { id: "terminal.attach-policy-result/v1", owner: "gui", typeName: "TerminalAttachPolicyResult" },
    { id: "terminal.create-session-payload/v1", owner: "gui", typeName: "CreateTerminalSessionPayload" },
    { id: "terminal.resize-session-payload/v1", owner: "gui", typeName: "ResizeTerminalSessionPayload" },
    { id: "terminal.session-detail-result/v1", owner: "gui", typeName: "TerminalSessionDetailResult" },
    { id: "terminal.session-error/v1", owner: "gui", typeName: "TerminalSessionFailure" },
    { id: "terminal.session-id-payload/v1", owner: "gui", typeName: "TerminalSessionIdPayload" },
    { id: "terminal.session-list-result/v1", owner: "gui", typeName: "TerminalSessionListResult" }
  ];
  const deferredEntries = options.deferredEntries ?? [];
  const deferredMethods = new Set(deferredEntries.map((entry) => entry.guiBridgeMethod));
  const preloadCapabilities = options.preloadCapabilities ?? Object.fromEntries(options.preloadMethods.map((method) => [
    method,
    deferredMethods.has(method)
      ? { method, status: "deferred", reason: `${method} is deferred in this fixture.` }
      : { method, status: "shipped" }
  ]));
  const handlerImplementations = options.handlerImplementations
    ?? options.handlerMethods.map((method) => ({ method, serviceMethod: method }));
  const terminalRoutes = options.terminalRoutes ?? requiredTerminalRoutes();
  const terminalMethods = options.terminalMethods ?? [...new Set(terminalRoutes.map((entry) => entry.serviceMethod))];
  const taskWritePolicyEntries = options.taskWritePolicyEntries ?? [];
  writeFileSync(path.join(root, "packages/application/src/task-write-route-policy.ts"), [
    "export const taskWriteApiRoutePolicies = [",
    ...taskWritePolicyEntries.map((entry) => `  ${JSON.stringify(entry)},`),
    "] as const;",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, "packages/gui/src/api/api-contract-registry.ts"), [
    ...(taskWritePolicyEntries.length > 0
      ? ["import { taskWriteApiRoutePolicies } from '../../../application/src/task-write-route-policy.ts';"]
      : []),
    "export interface EmptyGuiPayload {}",
    "export const apiSchemaContracts = [",
    ...schemaContracts.map((entry) => `  ${JSON.stringify(entry)},`),
    "] as const;",
    "export const apiRouteContracts = [",
    ...options.registryEntries.map((entry) => `  ${JSON.stringify(entry)},`),
    ...(taskWritePolicyEntries.length > 0 ? ["  ...taskWriteApiRoutePolicies,"] : []),
    ...terminalRoutes.map((entry) => `  ${JSON.stringify(entry)},`),
    "] as const;",
    "export const deferredGuiBridgeContracts = [",
    ...deferredEntries.map((entry) => `  ${JSON.stringify(entry)},`),
    "] as const;",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, "packages/gui/src/preload/allowlist.ts"), options.registryDerivedPreload
    ? [
        "import { apiRouteContracts, deferredGuiBridgeContracts } from '../api/api-contract-registry.ts';",
        "export const preloadAllowlist = apiRouteContracts",
        "  .map((route) => route.guiBridgeMethod)",
        "  .filter(Boolean)",
        "  .concat(deferredGuiBridgeContracts.map((contract) => contract.guiBridgeMethod));",
        "export const allowedPreloadApi = Object.fromEntries(preloadAllowlist.map((method) => [method, method]));",
        "export const preloadApiCapabilities = Object.fromEntries(preloadAllowlist.map((method) => [method, { method, status: 'shipped' }]));",
        ""
      ].join("\n")
    : [
        "export const allowedPreloadApi = {",
        ...options.preloadMethods.map((method) => `  ${method}: ${JSON.stringify(method)},`),
        "} as const;",
        "export const preloadApiCapabilities = {",
        ...Object.entries(preloadCapabilities).map(([method, capability]) => `  ${method}: ${JSON.stringify(capability)},`),
        "} as const;",
        ""
      ].join("\n"), "utf8");
  writeFileSync(path.join(root, "packages/gui/src/api/service-bridge.ts"), [
    "export const guiBridgeHandlerImplementations = {",
    ...handlerImplementations.map((handler) => `  ${handler.method}: { serviceMethod: ${JSON.stringify(handler.serviceMethod)}, invoke: () => service.${handler.serviceMethod}() },`),
    "} as const;",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, "packages/application/src/index.ts"), [
    ...schemaContracts
      .filter((entry) => entry.owner === "application")
      .map((entry) => `export interface ${entry.typeName} {}`),
    "export interface LocalControllerService {",
    ...options.serviceMethods.map((method) => `  readonly ${method}: () => unknown;`),
    "}",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, "packages/gui/src/terminal/session-registry.ts"), [
    ...schemaContracts
      .filter((entry) => entry.owner === "gui" && entry.typeName !== "EmptyGuiPayload")
      .map((entry) => `export interface ${entry.typeName} {}`),
    "export interface TerminalSessionService {",
    ...terminalMethods.map((method) => `  readonly ${method}: () => unknown;`),
    "}",
    ""
  ].join("\n"), "utf8");
}

function route(overrides = {}) {
  return {
    id: "tasks.list",
    method: "GET",
    path: "/api/tasks",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.task-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTasks",
    auth: "local-session-token",
    guiBridgeMethod: "getTasks",
    ...overrides
  };
}

function terminalRoute(overrides = {}) {
  return {
    id: "terminal.sessions.list",
    method: "GET",
    path: "/api/terminal/sessions",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "terminal.session-list-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "listSessions",
    auth: "local-session-token",
    ...overrides
  };
}

function requiredTerminalRoutes() {
  return [
    terminalRoute({
      id: "terminal.sessions.create",
      method: "POST",
      path: "/api/terminal/sessions",
      inputSchemaId: "terminal.create-session-payload/v1",
      outputSchemaId: "terminal.session-detail-result/v1",
      serviceMethod: "createSession"
    }),
    terminalRoute({
      id: "terminal.sessions.list",
      method: "GET",
      path: "/api/terminal/sessions",
      inputSchemaId: "gui.empty/v1",
      outputSchemaId: "terminal.session-list-result/v1",
      serviceMethod: "listSessions"
    }),
    terminalRoute({
      id: "terminal.sessions.get",
      method: "GET",
      path: "/api/terminal/sessions/:id",
      inputSchemaId: "terminal.session-id-payload/v1",
      outputSchemaId: "terminal.session-detail-result/v1",
      serviceMethod: "getSession"
    }),
    terminalRoute({
      id: "terminal.sessions.attach",
      method: "WS",
      path: "/api/terminal/sessions/:id/attach",
      inputSchemaId: "terminal.session-id-payload/v1",
      outputSchemaId: "terminal.attach-policy-result/v1",
      serviceMethod: "attachSession"
    }),
    terminalRoute({
      id: "terminal.sessions.resize",
      method: "POST",
      path: "/api/terminal/sessions/:id/resize",
      inputSchemaId: "terminal.resize-session-payload/v1",
      outputSchemaId: "terminal.session-detail-result/v1",
      serviceMethod: "resizeSession"
    }),
    terminalRoute({
      id: "terminal.sessions.close",
      method: "DELETE",
      path: "/api/terminal/sessions/:id",
      inputSchemaId: "terminal.session-id-payload/v1",
      outputSchemaId: "terminal.session-detail-result/v1",
      serviceMethod: "closeSession"
    })
  ];
}
