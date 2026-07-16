import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureMachinePeopleRoster(
  userRoot: string,
  author: { readonly name: string; readonly email: string }
): string {
  const peoplePath = path.join(userRoot, "people.yaml");
  if (existsSync(peoplePath)) return peoplePath;
  const personId = machinePersonId(author);
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(peoplePath, [
      "schema: harness-people/v1",
      "people:",
      `  - personId: ${personId}`,
      `    displayName: ${JSON.stringify(author.name)}`,
      `    primaryEmail: ${JSON.stringify(author.email)}`,
      "    roles: [owner]",
      "    credentials:",
      "      - kind: unix-socket-owner-boundary",
      `        issuer: host:${os.hostname()}`,
      `        subject: ${process.getuid?.() ?? 0}`,
      "roles:",
      "  - roleId: owner",
      "    commandClasses: [admin, repo-write, repo-read, arbiter]",
      ""
    ].join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as { readonly code?: string }).code !== "EEXIST") throw error;
  }
  return peoplePath;
}

function machinePersonId(author: { readonly name: string; readonly email: string }): string {
  const name = author.name.normalize("NFKD").replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toLowerCase() || "local";
  const suffix = createHash("sha256").update(author.email.trim().toLowerCase()).digest("hex").slice(0, 10);
  return `person_${name}_${suffix}`;
}
