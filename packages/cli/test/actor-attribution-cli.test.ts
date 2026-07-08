import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI write commands require explicit local actor attribution", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task", "--title", "No Actor"], false, withoutActorAttributionEnv());

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "write_rejected");
    assert.match(result.error?.hint ?? "", /Local CLI writes require explicit actor attribution/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), false);
  });
});

test("CLI local writes preserve distinct git authors for distinct actors", () => {
  withTempRoot((rootDir) => {
    const aliceEnv = actorEnv("human:person_alice", "Alice Owner", "alice@example.test");
    const bobEnv = actorEnv("human:person_bob", "Bob Builder", "bob@example.test");
    runJson(rootDir, ["init"], true, aliceEnv);
    const alice = runJson(rootDir, ["new-task", "--title", "Alice Authored"], true, aliceEnv);
    const bob = runJson(rootDir, ["new-task", "--title", "Bob Authored"], true, bobEnv);

    assertGeneratedTaskId(alice.taskId);
    assertGeneratedTaskId(bob.taskId);
    const authors = git(path.join(rootDir, "harness"), ["log", "--format=%an <%ae>"]).split(/\r?\n/u);
    assert.equal(authors.includes("Alice Owner <alice@example.test>"), true);
    assert.equal(authors.includes("Bob Builder <bob@example.test>"), true);
  });
});

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function actorEnv(actor: string, name: string, email: string): Readonly<Record<string, string>> {
  return {
    HARNESS_ACTOR: actor,
    HARNESS_GIT_AUTHOR_NAME: name,
    HARNESS_GIT_AUTHOR_EMAIL: email
  };
}

function withoutActorAttributionEnv(): Readonly<Record<string, string>> {
  return {
    HARNESS_ACTOR: "",
    HARNESS_GIT_AUTHOR_NAME: "",
    HARNESS_GIT_AUTHOR_EMAIL: "",
    GIT_AUTHOR_NAME: "",
    GIT_AUTHOR_EMAIL: ""
  };
}

function git(rootDir: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
