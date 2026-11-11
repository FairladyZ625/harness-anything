// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkFleetTransferBoundary,
  forwardingSources,
  findFleetForwardingBypasses,
  findFleetTransferBypasses,
} from "../fleet-transfer-boundary.mjs";

test("Fleet production paths use the unified transfer boundary", () => {
  assert.deepEqual(checkFleetTransferBoundary(process.cwd()), []);
});

test("the negative direct large reply fixture is rejected", () => {
  const violations = findFleetTransferBypasses(
    'socket.write(JSON.stringify({ schema: "fleet.operational.read.result/v1", result: payload }) + "\\n");',
    "negative-fixture.ts",
  );
  assert.deepEqual(violations, [{ file: "negative-fixture.ts", line: 1, reason: "direct JSON socket write" }]);
});

test("the gate catches a direct JSON write split over source lines", () => {
  const violations = findFleetTransferBypasses(
    `socket
  .write(
    JSON
      .stringify(payload),
  );`,
    "multiline-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    { file: "multiline-negative-fixture.ts", line: 1, reason: "direct JSON socket write" },
  ]);
});

test("the gate catches a JSON reply assigned before the socket write", () => {
  const violations = findFleetTransferBypasses(
    `const reply = JSON.stringify(payload);\nconst line = reply;\nsocket.write(line + "\\n");`,
    "assigned-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    { file: "assigned-negative-fixture.ts", line: 3, reason: "JSON payload reaches socket.write through a variable" },
  ]);
});

test("the gate scans newly added Fleet source files", () => {
  const violations = findFleetTransferBypasses(
    'socket.write(JSON.stringify({ schema: "fleet.operational.read.result/v1", result: payload }));',
    "packages/daemon/src/fleet/new-rpc.ts",
  );
  assert.equal(violations[0]?.reason, "direct JSON socket write");
});

test("the full checker scans a real nested Fleet source path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-transfer-boundary-"));
  try {
    const fixture = readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/fleet-transfer-bypasses/nested/new-rpc.ts"),
      "utf8",
    );
    const nested = path.join(root, "packages/daemon/src/fleet/new/transport");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/daemon-host-repository-api.ts"), "export {};\n");
    writeFileSync(path.join(nested, "new-rpc.ts"), fixture);
    const errors = checkFleetTransferBoundary(root);
    assert.deepEqual(errors, [
      "packages/daemon/src/fleet/new/transport/new-rpc.ts:4: direct JSON socket write",
      "packages/daemon/src/fleet/new/transport/new-rpc.ts:5: JSON payload reaches socket.write through a variable",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the full checker rejects forwarding construction in an unregistered CLI file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-forwarding-boundary-"));
  try {
    const newCallsite = path.join(root, "packages/cli/src/daemon/new-forwarding-callsite.ts");
    mkdirSync(path.dirname(newCallsite), { recursive: true });
    writeFileSync(newCallsite, 'const request = { schema: "fleet.task.action/v1", repoId, action };\n');
    mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/daemon-host-repository-api.ts"), "export {};\n");
    const errors = checkFleetTransferBoundary(root);
    assert.deepEqual(errors, [
      "packages/cli/src/daemon/new-forwarding-callsite.ts:1: forwarding construction fleetRequestEnvelope is outside ForwardingPort",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// dec_2C49A4516E540906721AF01840: local and ingress responsibilities have no forwarding exemption.
test("the zero-baseline gate distinguishes local reads, authorization, types and ingress replies", () => {
  const source = `
    type Frame = { kind: "fleet-runtime"; payload: JsonObject };
    function replica(root) { const config = readFleetEdgeConfig(root); return readEdgeRepository(config); }
    function binding(auth) { return { keycloakAuthorization: { session: { accessToken: auth.oidcPrincipal.accessToken } } }; }
    function ingress(frame) { return immediate({ schema: "fleet.runtime.event.result/v1", receipt: frame }); }
    function actionResult(action) { if (action.kind === "task-start") return { schema: "fleet.task.result/v1" }; }
    function local(fromFile) { if (fromFile) return workspaceText(root, fromFile); }
  `;
  for (const file of ["packages/daemon/src/local.ts", "packages/cli/src/daemon/local.ts"])
    assert.deepEqual(findFleetForwardingBypasses(source, file), []);
});

test("the full checker applies zero allowance to new CLI and daemon forwarding sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-forwarding-new-sources-"));
  try {
    const fixtures = [
      [
        "packages/cli/src/daemon/new-envelope.ts",
        'const request = { schema: "fleet.task.command/v1", messageId, repoId: config.repoId, nodeId: config.nodeId, action };',
      ],
      [
        "packages/daemon/src/new-edge-target.ts",
        'const config = JSON.parse(readFileSync(path.join(rootDir, "fleet-edge.json"), "utf8"));',
      ],
      [
        "packages/daemon/src/new-credential-assembly.ts",
        "const hostBinding = { credential: config.credential, accessToken: command.action.executor?.accessToken };",
      ],
      [
        "packages/daemon/src/new-method-selection.ts",
        'const method = action.kind === "task-start" ? "fleet.task.action" : "fleet.runtime.control";',
      ],
      ["packages/daemon/src/new-runtime-lookup.ts", "edgeRuntimeFor(rootDir);"],
      ["packages/cli/src/daemon/new-file-branch.ts", "if (fromFile) payload.action = JSON.parse(value);"],
    ];
    for (const [relative, source] of fixtures) {
      const absolute = path.join(root, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, `${source}\n`);
    }
    mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/daemon-host-repository-api.ts"), "export {};\n");
    const errors = checkFleetTransferBoundary(root);
    assert.deepEqual(
      errors
        .map((error) => error.match(/forwarding construction ([A-Za-z][A-Za-z0-9]+)/u)?.[1])
        .filter(Boolean)
        .sort(),
      [
        "directFleetEdgeFileRead",
        "fleetMethodByDiscriminant",
        "fleetRequestEnvelope",
        "forwardingCredentialAssembly",
        "fromFileSpecialCase",
        "edgeRuntimeFor",
      ].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate catches socket aliases and stringify wrappers", () => {
  const violations = findFleetTransferBypasses(
    `const writer = socket;
const encodeReply = (value) => JSON.stringify(value);
writer.write(encodeReply(reply));`,
    "alias-wrapper-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    {
      file: "alias-wrapper-negative-fixture.ts",
      line: 3,
      reason: "JSON payload reaches socket.write through a variable",
    },
  ]);
});

test("the gate catches a wrapper result assigned before the socket write", () => {
  const violations = findFleetTransferBypasses(
    `const stringifyReply = (value) => JSON.stringify(value);
const line = stringifyReply(reply);
socket.write(line);`,
    "wrapper-assignment-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    {
      file: "wrapper-assignment-negative-fixture.ts",
      line: 3,
      reason: "JSON payload reaches socket.write through a variable",
    },
  ]);
});

test("the forwarding ratchet rejects route-level construction and file special cases", () => {
  const violations = findFleetForwardingBypasses(
    `const config = readFleetEdgeConfig(root);\nif (fromFile) payload.action = JSON.parse(value);`,
    "packages/cli/src/daemon/client.ts",
  );
  assert.deepEqual(
    violations.map(({ fingerprint, line }) => ({ fingerprint, line })),
    [
      { fingerprint: "readFleetEdgeConfig", line: 1 },
      { fingerprint: "fromFileSpecialCase", line: 2 },
    ],
  );
});

test("the full checker rejects the actual sender with spread-based location assembly", () => {
  const source = `import path from 'node:path';
import { readFleetEdgeConfig } from './client/fleet-edge-config.ts';
import { runFleetEdgeTask } from './fleet-edge-task.ts';
export function bypass(root: string, action: Parameters<typeof runFleetEdgeTask>[0]['payload']['action'], readAccessToken: () => Promise<string | undefined>) {
 const config = readFleetEdgeConfig(root);
 if (!config) throw new Error('missing config');
 return runFleetEdgeTask({payload: {...config, caPath: path.resolve(root, config.caPath), viewRoot: path.resolve(root, config.viewRoot), workspaceRoot: root, action}}, readAccessToken, 'domain');
}`;
  for (const file of [
    "packages/daemon/src/reintroduced-forwarder.ts",
    "packages/cli/src/daemon/reintroduced-forwarder.ts",
  ])
    assert.deepEqual(
      new Set(findFleetForwardingBypasses(source, file).map((row) => row.fingerprint)),
      new Set(["forwardingTransportDependency", "readFleetEdgeConfig", "forwardingTransportCall"]),
    );
  assert.deepEqual(findFleetForwardingBypasses(source, "packages/daemon/src/fleet/forwarding-port.ts"), []);
  const root = mkdtempSync(path.join(tmpdir(), "fleet-forwarding-real-sender-"));
  try {
    mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/daemon-host-repository-api.ts"), "export {};\n");
    for (const file of [
      "packages/daemon/src/reintroduced-forwarder.ts",
      "packages/cli/src/daemon/reintroduced-forwarder.ts",
      "packages/cli/src/daemon/fleet-payload-serializer.ts",
      "packages/daemon/src/fleet/forwarding-port.ts",
    ]) {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(
        absolute,
        source.replaceAll("'./", file.startsWith("packages/cli/") ? "'../../../daemon/src/" : "'./"),
      );
      assert.equal(forwardingSources(root).includes(file), true, file);
      const errors = checkFleetTransferBoundary(root);
      if (file.endsWith("forwarding-port.ts")) assert.deepEqual(errors, []);
      else {
        assert.equal(
          errors.some((error) => error.startsWith(file) && error.includes("forwardingTransportDependency")),
          true,
          file,
        );
        assert.equal(
          errors.some((error) => error.startsWith(file) && error.includes("forwardingTransportCall")),
          true,
          file,
        );
      }
      rmSync(absolute);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sender aliases and re-exports cannot evade the forwarding dependency boundary", () => {
  const sources = [
    `import { runFleetEdgeTask as send } from './fleet-edge-task.ts'; send(request, token, 'domain');`,
    `export { runFleetEdgeTask as send } from './fleet-edge-task.ts';`,
    `import * as tasks from './fleet-edge-task.ts'; const send = tasks.runFleetEdgeTask; send(request, token, 'domain');`,
    `import * as tasks from './fleet-edge-task.ts'; const send = tasks['runFleetEdgeTask']; send(request, token, 'domain');`,
    `import * as tasks from './fleet-edge-task.ts'; const { runFleetEdgeTask: send } = tasks; send(request, token, 'domain');`,
  ];
  const root = mkdtempSync(path.join(tmpdir(), "fleet-forwarding-sender-aliases-"));
  try {
    mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/daemon-host-repository-api.ts"), "export {};\n");
    for (const file of ["packages/daemon/src/forwarder.ts", "packages/cli/src/daemon/fleet-payload-serializer.ts"]) {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      for (const source of sources) {
        writeFileSync(
          absolute,
          source.replaceAll("'./", file.startsWith("packages/cli/") ? "'../../../daemon/src/" : "'./"),
        );
        assert.equal(
          checkFleetTransferBoundary(root).some(
            (error) => error.startsWith(file) && error.includes("forwardingTransportDependency"),
          ),
          true,
          `${file}: ${source}`,
        );
      }
      rmSync(absolute);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sender boundary preserves type-only and local replica reader dependencies", () => {
  const source = `import type { runFleetEdgeTask } from './fleet-edge-task.ts';
import { type runFleetEdgeTask as Sender } from './fleet-edge-task.ts';
export type { runFleetEdgeTask as SenderType } from './fleet-edge-task.ts';
import { readFleetEdgeConfig } from './client/fleet-edge-config.ts';
import { runFleetEdgeRepositoryRead } from './fleet-edge-task.ts';
import * as tasks from './fleet-edge-task.ts';
type Request = Parameters<typeof runFleetEdgeTask>[0];
function replica(root) { const config = readFleetEdgeConfig(root); return runFleetEdgeRepositoryRead(config); }
function otherReplica(root) { const config = readFleetEdgeConfig(root); return tasks.runFleetEdgeRepositoryRead(config); }
`;
  assert.deepEqual(findFleetForwardingBypasses(source, "packages/daemon/src/replica.ts"), []);
});

test("the forwarding ratchet rejects every prohibited construction responsibility", () => {
  const fixtures = [
    ["envelope", 'const request = { schema: "fleet.task.action/v1", repoId, action };', "fleetRequestEnvelope"],
    ["edge-config", 'const target = readFileSync("fleet-edge.json", "utf8");', "directFleetEdgeFileRead"],
    [
      "credential",
      "const hostBinding = { credential: config.credential, accessToken: executor.accessToken };",
      "forwardingCredentialAssembly",
    ],
    [
      "discriminant",
      'const method = action.kind === "task-start" ? "fleet.task.action" : "fleet.runtime.control";',
      "fleetMethodByDiscriminant",
    ],
    ["qualified-read", 'fs.readFileSync("fleet-edge.json", "utf8");', "directFleetEdgeFileRead"],
    ["qualified-runtime", "runtime.edgeRuntimeFor(rootDir);", "edgeRuntimeFor"],
    ["if-dispatch", 'if (action.kind === "task-start") return "fleet.task.action";', "fleetMethodByDiscriminant"],
    [
      "switch-dispatch",
      'switch (command.action.kind) { case "task-start": return "fleet.task.action"; }',
      "fleetMethodByDiscriminant",
    ],
    ["runtime", "edgeRuntimeFor(rootDir);", "edgeRuntimeFor"],
    ["file", "if (fromFile) payload.action = JSON.parse(value);", "fromFileSpecialCase"],
  ];
  for (const [name, source, fingerprint] of fixtures) {
    const violations = findFleetForwardingBypasses(source, `packages/daemon/src/${name}.ts`);
    assert.equal(
      violations.some((violation) => violation.fingerprint === fingerprint),
      true,
      name,
    );
  }
});

test("an unregistered CLI or daemon production source has zero allowance", () => {
  assert.equal(
    findFleetForwardingBypasses(
      'const request = { schema: "fleet.task.action/v1", repoId, action };',
      "packages/cli/src/daemon/new-forwarding-callsite.ts",
    ).length,
    1,
  );
  assert.equal(forwardingSources(process.cwd()).includes("packages/cli/src/daemon/client.ts"), true);
});

test("wire requests can only be encoded by the Fleet peer transport", () => {
  const source = 'session.request({ schema: "fleet.task.command/v1", action });';
  assert.deepEqual(findFleetForwardingBypasses(source, "packages/daemon/src/fleet/peer.ts"), []);
  assert.equal(
    findFleetForwardingBypasses(source, "packages/cli/src/daemon/route.ts")[0]?.fingerprint,
    "fleetRequestEnvelope",
  );
});

test("the forwarding boundary permits the serializer and forwarding port", () => {
  assert.deepEqual(
    findFleetForwardingBypasses(
      'const request = { schema: "fleet.task.action/v1", repoId, action }; if (fromFile) return action;',
      "packages/cli/src/daemon/fleet-payload-serializer.ts",
    ),
    [],
  );
  assert.deepEqual(
    findFleetForwardingBypasses(
      'const request = { schema: "fleet.task.action/v1", repoId, action };',
      "packages/daemon/src/fleet/forwarding-port.ts",
    ),
    [],
  );
});

test("the forwarding ratchet allows construction inside the declared serializer", () => {
  assert.deepEqual(
    findFleetForwardingBypasses(
      "const config = readFleetEdgeConfig(root); if (fromFile) return config;",
      "packages/cli/src/daemon/fleet-payload-serializer.ts",
    ),
    [],
  );
});

test("the full checker preserves encoding, types, local reads, ingress and wire responsibilities", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-forwarding-owned-responsibilities-"));
  try {
    const sources = [
      ["packages/daemon/src/daemon-host-repository-api.ts", "export {};"],
      [
        "packages/cli/src/daemon/fleet-payload-serializer.ts",
        `
        import type { runFleetEdgeTask } from '../../../daemon/src/fleet-edge-task.ts';
        type Request = Parameters<typeof runFleetEdgeTask>[0];
        function encode(fromFile) { if (fromFile) return { schema: "fleet.task.action/v1", action: JSON.parse(fromFile) }; }
      `,
      ],
      [
        "packages/daemon/src/local-replica.ts",
        `
        import { runFleetEdgeRepositoryRead } from './fleet-edge-task.ts';
        function replica(root) { const config = readFleetEdgeConfig(root); return runFleetEdgeRepositoryRead(config); }
        function binding(auth) { return { keycloakAuthorization: { session: { accessToken: auth.oidcPrincipal.accessToken } } }; }
        function ingress(frame) { return { schema: "fleet.runtime.event.result/v1", receipt: frame }; }
      `,
      ],
      [
        "packages/daemon/src/fleet/peer.ts",
        `
        import { encodeFleetFrames } from './transfer.ts';
        function wire(action) { return session.request({ schema: "fleet.task.command/v1", action }); }
      `,
      ],
      [
        "packages/daemon/src/fleet/forwarding-port.ts",
        `
        import { runFleetEdgeTask } from '../fleet-edge-task.ts';
        function forward(payload) { return runFleetEdgeTask({ payload }, token, 'domain'); }
      `,
      ],
    ];
    for (const [file, source] of sources) {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, source);
      assert.equal(forwardingSources(root).includes(file), true, file);
    }
    assert.deepEqual(checkFleetTransferBoundary(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
