import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { JsonRpcLineClient } from "../../../daemon/src/index.ts";
import { runDaemonConnect } from "../../src/commands/daemon/connect.ts";

export function writePeopleRoster(rootDir: string, person: {
  readonly personId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: "owner" | "maintainer";
}): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    `  - personId: ${person.personId}`,
    `    displayName: ${person.displayName}`,
    `    primaryEmail: ${person.email}`,
    `    roles: [${person.role}]`,
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    ""
  ].join("\n"), "utf8");
  commitPeopleRoster(harnessRoot);
}

export function writeForcedCommandTeamRoster(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  const configPath = path.join(harnessRoot, "harness.yaml");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(configPath, /settings:\n(?:[\s\S]*?)  identity:\n/u.test(config)
    ? (config.includes("    mode: local") ? config.replace("    mode: local", "    mode: remote") : config.replace("  identity:\n", "  identity:\n    mode: remote\n"))
    : config.replace("settings:\n", "settings:\n  identity:\n    mode: remote\n"), "utf8");
  writeFileSync(path.join(harnessRoot, "people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_alice",
    "    displayName: Alice",
    "    primaryEmail: alice@example.test",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: ssh-forced-command-person",
    `        issuer: host:${hostname()}`,
    "        subject: person_alice",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "  - personId: person_bob",
    "    displayName: Bob",
    "    primaryEmail: bob@example.test",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: ssh-forced-command-person",
    `        issuer: host:${hostname()}`,
    "        subject: person_bob",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    ""
  ].join("\n"), "utf8");
  commitPeopleRoster(harnessRoot);
}

export async function forcedCommandRequest(
  rootDir: string,
  userRoot: string,
  personId: string,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const expectedOriginalCommand = "ha daemon connect --stdio";
  const connect = runDaemonConnect([
    "daemon",
    "connect",
    "--stdio",
    "--principal",
    personId,
    "--expect-original-command",
    expectedOriginalCommand
  ], {
    rootDir,
    env: {
      ...process.env,
      HARNESS_DAEMON_USER_ROOT: userRoot,
      SSH_ORIGINAL_COMMAND: expectedOriginalCommand,
      USER: "shared-harness"
    },
    streams: { input, output, error },
    // This fixture exercises forced-command framing after sshd verification.
    // daemon-connect.test.ts owns the process-witness contract itself.
    verifySshdContext: () => true
  });
  const client = new JsonRpcLineClient(output, input);
  try {
    const hello = await client.request("protocol.hello", { protocolVersion: 1 });
    assert.equal(hello.ok, true);
    return await client.request(method, params as never) as Record<string, unknown>;
  } finally {
    client.close();
    assert.equal(await connect, 0);
  }
}

export function receiptDataString(receipt: Record<string, unknown>, key: string): string {
  const details = receipt.details as Record<string, unknown> | undefined;
  const data = details?.data as Record<string, unknown> | undefined;
  assert.equal(typeof data?.[key], "string");
  return data[key] as string;
}

function commitPeopleRoster(harnessRoot: string): void {
  if (!existsSync(path.join(harnessRoot, ".git"))) return;
  execFileSync("git", ["-C", harnessRoot, "add", "--", "harness.yaml", "people.yaml"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "chore: configure daemon people roster"], {
    stdio: "ignore",
    env: gitAuthorEnv(harnessRoot)
  });
}

function gitAuthorEnv(rootDir: string): NodeJS.ProcessEnv {
  const name = process.env.HARNESS_GIT_AUTHOR_NAME ?? "Harness Test";
  const email = process.env.HARNESS_GIT_AUTHOR_EMAIL ?? "harness@example.test";
  return {
    ...process.env,
    HOME: path.join(rootDir, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? name,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? email
  };
}
