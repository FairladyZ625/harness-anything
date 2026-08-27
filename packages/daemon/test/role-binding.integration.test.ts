// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { binding, localSystemBinding } from "../src/daemon-host-binding.ts";

test("daemon identity derives the RoleBinding contract and joins declared bindings without a second map", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-role-binding-")),
    uid = process.getuid?.() ?? 0,
    peoplePath = path.join(rootDir, "harness/people.yaml"),
    roster = (commandClasses: readonly string[]) => ({
      schema: "harness-people/v1",
      people: [
        {
          personId: "person_owner",
          displayName: "Owner",
          roles: ["owner"],
          credentials: [
            {
              kind: "unix-socket-owner-boundary",
              issuer: `host:${hostname()}`,
              subject: String(uid),
            },
          ],
        },
      ],
      roles: [{ roleId: "owner", commandClasses }],
      bindings: [
        {
          actor: { kind: "person", id: "person_owner" },
          role: "reviewer",
          target: "decision/dec_declared",
          source: "declared",
          expiresAt: null,
        },
      ],
    }),
    auth = {
      transportKind: "unix-socket" as const,
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary" as const,
      },
    };
  try {
    mkdirSync(path.dirname(peoplePath), { recursive: true });
    writeFileSync(peoplePath, `${JSON.stringify(roster(["repo-write"]), null, 2)}\n`);
    const resolved = await binding(rootDir, auth, "repo-write");
    assert.deepEqual(resolved.roleBindings, [
      {
        actor: { kind: "person", id: "person_owner" },
        role: "repo-write",
        target: "settings/repository",
        source: "derived",
        expiresAt: null,
      },
      {
        actor: { kind: "person", id: "person_owner" },
        role: "reviewer",
        target: "decision/dec_declared",
        source: "declared",
        expiresAt: null,
      },
    ]);
    assert.deepEqual(localSystemBinding(rootDir, "repo-write"), resolved);

    writeFileSync(peoplePath, `${JSON.stringify(roster(["repo-read"]), null, 2)}\n`);
    await assert.rejects(() => binding(rootDir, auth, "repo-write"), /lacks repo-write/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
