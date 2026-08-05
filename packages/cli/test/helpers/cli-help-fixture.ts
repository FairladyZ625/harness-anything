import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function cliHelp(rootDir: string, args: ReadonlyArray<string>): string {
  return execFileSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, ...args], {
    encoding: "utf8"
  });
}

export function packetTemplate(help: string): Readonly<Record<string, unknown>> {
  const match = help.match(/Packet template \(copy as [^)]+\):\n([\s\S]+?)(?:\n\n|$)/u);
  assert.ok(match, help);
  return JSON.parse(match[1]!.split("\n").map((line) => line.replace(/^  /u, "")).join("\n")) as Record<string, unknown>;
}

export function assertHelpOrder(help: string, fragments: ReadonlyArray<string>): void {
  let previous = -1;
  for (const fragment of fragments) {
    const index = help.indexOf(fragment, previous + 1);
    assert.ok(index > previous, `Expected help fragment after offset ${previous}: ${fragment}\n${help}`);
    previous = index;
  }
}
