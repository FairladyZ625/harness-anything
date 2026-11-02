// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinPolicyAdapter } from "@harness-anything/authorization-builtin";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { effectivePolicyGroupScopes, type AuthorizationProvider } from "@harness-anything/kernel";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

for (const kind of ["builtin", "keycloak"] as const) {
  test(`${kind}: single-person directory and policy administration obey the same contract`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-identity-parity-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const realm = fakeKeycloak();
    let provider: AuthorizationProvider, token: string, userToken: string;
    if (kind === "builtin") {
      const builtin = new BuiltinPolicyAdapter({ userRoot: root });
      builtin.addUser({
        username: "owner",
        personId: "owner",
        email: "owner@example.invalid",
        displayName: "Owner",
        password: "synthetic-owner-password",
      });
      token = builtin.issueCenterToken();
      userToken = "synthetic-owner-session";
      builtin.registerSession(userToken, {
        personId: "owner",
        subject: "owner",
        expiresAt: Date.now() + 60_000,
        sessionExpiresAt: null,
        roles: [],
      });
      provider = builtin;
    } else {
      userToken = realm.account("owner");
      provider = new KeycloakPolicyAdapter(
        { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" },
        realm.fetch,
      );
      token = "center-token";
    }
    const synced = await provider.syncBasePolicy(token);
    assert.ok(synced.scopeCount > 0);
    await provider.syncLoginClients(token);
    const people = await provider.readPeople(token);
    assert.equal(people.length, 1);
    assert.equal(people[0]!.personId, "owner");
    const userId = await provider.findUserId(token, "owner");
    assert.equal(userId, people[0]!.userId);
    assert.equal(await provider.findUserId(token, "missing-person"), undefined);
    assert.deepEqual(await provider.readPersonTeams(token, "owner"), []);
    await assert.rejects(provider.readPersonTeams(token, "missing-person"));
    assert.deepEqual(await provider.readTeams(token), []);
    assert.deepEqual(await provider.readNodes(token), []);
    assert.equal(await provider.readNode(token, "unknown-node"), undefined);
    assert.equal(await provider.authenticateNode("unknown-node", "wrong"), false);
    await provider.revokeNodes(token, []);
    // Every team/device operation is exercised at the adapter boundary. The local
    // provider refuses creation; the shared provider persists the same requested entity.
    if (kind === "builtin") {
      const node = {
        nodeId: "remote",
        personId: "owner",
        systemName: "remote",
        displayName: "Remote",
        platform: "linux",
        registeredAt: new Date().toISOString(),
        state: "active" as const,
        revision: 1,
        revocation: "complete" as const,
      };
      for (const operation of [
        () => provider.createTeam(token, "Team"),
        () => provider.readTeam(token, "team"),
        () => provider.readTeamMembers(token, "team"),
        () => provider.updateTeam(token, "team", "Renamed"),
        () => provider.deleteTeam(token, "team"),
        () => provider.setTeamMember(token, "team", userId!, true),
        () => provider.createNode(token, node, "credential"),
        () => provider.writeNode(token, node),
        () => provider.rotateNodeCredential(token, node, "rotated"),
        () => provider.revokeNode(token, node),
        () => provider.revokeNodes(token, [node]),
        () => provider.transferNode(token, node, "other"),
        () => provider.revokeNodeConsent(token, node.nodeId, node.personId),
        () => provider.deleteNode(token, node.nodeId),
      ])
        await assert.rejects(operation(), { code: "identity_plugin_required" });
    } else {
      await provider.createTeam(token, "Team");
      const team = (await provider.readTeams(token))[0]!;
      assert.equal((await provider.readTeam(token, team.id)).name, "Team");
      await provider.setTeamMember(token, team.id, userId!, true);
      assert.deepEqual(await provider.readTeamMembers(token, team.id), [userId]);
      assert.deepEqual(await provider.readPersonTeams(token, "owner"), [team.id]);
      await provider.updateTeam(token, team.id, "Renamed");
      assert.equal((await provider.readTeam(token, team.id)).name, "Renamed");
      await provider.setTeamMember(token, team.id, userId!, false);
      await provider.deleteTeam(token, team.id);
      await provider.createNode(token, { nodeId: "remote", personId: "owner" }, "credential");
      const node = (await provider.readNode(token, "remote"))!;
      assert.equal(node.personId, "owner");
      await provider.writeNode(token, { ...node, displayName: "Renamed" });
      await provider.rotateNodeCredential(token, node, "rotated");
      await provider.revokeNodeConsent(token, node.nodeId, node.personId);
      await provider.transferNode(token, node, "owner");
      await provider.revokeNode(token, node);
      await provider.revokeNodes(token, [node]);
      await provider.deleteNode(token, node.nodeId);
      assert.equal((await provider.readNode(token, node.nodeId))?.state, "removed");
      assert.equal(await provider.authenticateNode(node.nodeId, "rotated"), false);
    }
    const principal = {
      personId: "owner",
      repoId: "claimed",
      runtimeSessionId: "runtime-contract",
      dispatchId: "dispatch-contract",
      taskId: null,
      executionId: null,
      role: "session" as const,
      source: "local" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const credential = await provider.issueExecutionCredential(token, principal);
    assert.deepEqual(await provider.authenticateExecutionCredential(token, credential), principal);
    assert.deepEqual(await provider.readExecutionPrincipal(token, principal.dispatchId), principal);
    await assert.rejects(provider.authenticateExecutionCredential(token, "invalid-credential"));
    const lifetime = provider.sessionLifetimeBounds.minimumSeconds;
    await provider.writeSessionLifetime(token, lifetime);
    assert.equal(await provider.readSessionLifetime(token), lifetime);
    assert.equal(await provider.validateUserAccessToken(userToken, "owner"), true);
    assert.equal(await provider.validateUserAccessToken(userToken, "other"), false);
    const groups = await provider.readPolicyGroups(token);
    provider.validatePolicyGroups(groups);
    assert.throws(() =>
      provider.validatePolicyGroups([{ id: "bad", base: false, scopes: ["unknown-scope"], composites: [] }]),
    );
    const custom = { id: "reader", base: false, displayName: "Reader", scopes: ["repository-read"], composites: [] };
    await provider.writePolicyGroup(token, custom, undefined);
    assert.deepEqual(
      (await provider.readPolicyGroups(token)).find((group) => group.id === custom.id),
      custom,
    );
    const grant = { groupId: "reader", resource: "repo-contract", userIds: [userId!] };
    await provider.writeGrant(token, grant, custom.scopes);
    assert.ok(
      (await provider.readGrants(token)).some(
        (value) => value.groupId === "reader" && value.resource === "repo-contract",
      ),
    );
    const decide = (action: string, repoId = "repo-contract", accessToken = userToken) =>
      provider.authorize({ userAccessToken: accessToken, action, resource: { kind: "repository", repoId } });
    assert.equal((await decide("repository-read")).outcome, "allowed");
    assert.equal((await decide("task-create")).outcome, "denied");
    assert.equal((await decide("repository-read", "other-repo")).outcome, "denied");
    assert.equal((await decide("repository-read", "repo-contract", "invalid-token")).outcome, "denied");
    assert.equal(
      (
        await provider.authorizePerson({
          adminAccessToken: token,
          personId: "owner",
          action: "repository-read",
          resource: { kind: "repository", repoId: "repo-contract" },
        })
      ).outcome,
      "allowed",
    );
    const changed = { ...custom, scopes: ["task-create"] };
    await provider.writePolicyGroup(token, changed, custom);
    await provider.materializeGrants(token, new Set(["reader"]));
    assert.equal((await decide("repository-read")).outcome, "denied");
    assert.equal((await decide("task-create")).outcome, "allowed");
    await provider.writeGrant(token, { ...grant, userIds: [] }, []);
    assert.equal((await decide("task-create")).outcome, "denied");
    await provider.deletePolicyGroup(token, "reader");
    assert.equal(
      (await provider.readPolicyGroups(token)).some((group) => group.id === "reader"),
      false,
    );
    await provider.claimRepositoryOwner(token, "claimed", "owner");
    assert.equal((await decide("task-create", "claimed")).outcome, "allowed");
    await assert.rejects(provider.claimRepositoryOwner(token, "missing", "other"), { code: "access_person_unknown" });
    const adminScopes = effectivePolicyGroupScopes(groups, "admin");
    await provider.writeGrant(token, { groupId: "admin", resource: "claimed", userIds: [] }, adminScopes);
    assert.equal(
      (await decide("task-create", "claimed")).outcome,
      "denied",
      "an owner marker never bypasses grant revocation",
    );
    await provider.syncBasePolicy(token);
    assert.equal(
      (await decide("task-create", "claimed")).outcome,
      "denied",
      "policy sync cannot resurrect a revoked grant",
    );
  });
}
