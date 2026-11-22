// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { policyActionDeclarations } from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization/keycloak";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { managedRbacSessionStore } from "@harness-anything/authorization/keycloak/managed-rbac-service";
import { oidcCenterSelections } from "../src/daemon-host/oidc-center-selection.ts";
import { evaluateKeycloakPerson } from "../src/daemon-host/repo-cell-authorization.ts";
import { createAuthorizationProvider, createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { localDefaultBinding } from "../src/daemon-host/daemon-host-binding.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { resolveRepoBootstrap } from "../src/daemon-host/repo-bootstrap.ts";
import { fetchWithTlsCa } from "../src/daemon-host/tls-ca-certificate.ts";
import { openWriterSupervisor } from "../src/daemon-host/writer-supervisor.ts";
import type { DaemonAuthenticationContext } from "../src/daemon-host/transport/auth-context.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";
import { initRepo } from "./task-surface.fixtures.ts";

function certificate(root: string, name: string) {
  const key = path.join(root, `${name}.key`),
    cert = path.join(root, `${name}.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      `/CN=${name}`,
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  return { key, cert, pem: readFileSync(cert, "utf8") };
}

async function tlsRealm(root: string) {
  const ca = certificate(root, "root"),
    other = certificate(root, "other"),
    key = path.join(root, "leaf.key"),
    csr = path.join(root, "leaf.csr"),
    cert = path.join(root, "leaf.pem"),
    ext = path.join(root, "leaf.ext");
  execFileSync(
    "openssl",
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=keycloak.test"],
    { stdio: "ignore" },
  );
  writeFileSync(ext, "subjectAltName=DNS:keycloak.test\nbasicConstraints=critical,CA:FALSE\n");
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca.cert,
      "-CAkey",
      ca.key,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-extfile",
      ext,
    ],
    { stdio: "ignore" },
  );
  const seen: { path: string; body: string }[] = [];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      seen.push({ path: request.url!, body: raw });
      const form = request.headers["content-type"]?.includes("x-www-form-urlencoded"),
        answer = await keycloak.fetch(`https://keycloak.test${request.url}`, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          ...(raw === "" ? {} : { body: form ? new URLSearchParams(raw) : raw }),
        });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const keycloak = fakeKeycloak(`https://127.0.0.1:${address.port}/realms/harness`);
  return {
    url: `https://127.0.0.1:${address.port}`,
    realm: "harness",
    clientId: "harness-center",
    certificate: ca.pem,
    servername: "keycloak.test",
    wrongCa: other.pem,
    keycloak,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

for (const trust of ["trusted", "missing-ca", "wrong-ca", "wrong-host"] as const) {
  test(`real HTTPS writer authorization: ${trust}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-writer-tls-")),
      realm = await tlsRealm(root),
      repoId = workspaceId("writer-tls"),
      repo = path.join(root, "repo"),
      rootDir = canonicalRoot(repo, true),
      provider = new KeycloakPolicyAdapter({ ...realm, resourceServerClientId: realm.clientId }, (input, init) =>
        fetchWithTlsCa(fetch, realm.certificate, input, init, realm.servername),
      ),
      accessToken = realm.keycloak.account("tls-person"),
      selected = {
        url: realm.url,
        realm: realm.realm,
        clientId: realm.clientId,
        ...(trust === "missing-ca" ? {} : { certificate: trust === "wrong-ca" ? realm.wrongCa : realm.certificate }),
        servername: trust === "wrong-host" ? "wrong.test" : realm.servername,
      },
      auth: DaemonAuthenticationContext = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
        oidcPrincipal: {
          provider,
          personId: "tls-person",
          subject: "tls-person",
          expiresAt: Date.now() + 60_000,
          accessToken,
          authority: selected,
        },
      };
    const opened: { supervisor?: Awaited<ReturnType<typeof openWriterSupervisor>> } = {};
    t.after(async () => {
      await opened.supervisor?.close();
      await realm.close();
      rmSync(root, { recursive: true, force: true });
    });
    await provider.syncBasePolicy("center-token");
    realm.keycloak.permit(
      "tls-person",
      repoId,
      policyActionDeclarations().map(({ policyAction }) => policyAction),
    );
    mkdirSync(repo);
    initRepo(rootDir);
    const authority = openPersistentWriterEpoch({ stateRoot: path.join(root, "epochs"), holderId: "tls-test" }),
      lease = authority.acquire(repoId),
      fence = {
        schema: "harness-writer-epoch-fence/v1" as const,
        stateRoot: path.join(root, "epochs"),
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      };
    authority.close();
    const open = openWriterSupervisor({
      repoId,
      rootDir,
      ownerId: "tls-test",
      defaultWriterEpochFence: fence,
      bootstrap: resolveRepoBootstrap({ rootDir, repoId, personId: "tls-person", displayName: "TLS" }, auth),
      keycloakCenter: async () => ({ ...selected, provider, accessToken: "center-token" }),
    });
    if (trust !== "trusted") {
      await assert.rejects(open, (error: Error & { code?: string }) => {
        assert.equal(error.code, "keycloak_tls_certificate_error");
        assert.match(
          error.message,
          trust === "wrong-host"
            ? /ERR_TLS_CERT_ALTNAME_INVALID/u
            : /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN/u,
        );
        assert.match(error.message, /CA.*certificate/iu);
        assert.doesNotMatch(error.message, /authorization endpoint could not be reached/u);
        return true;
      });
      return;
    }
    const supervisor = await open;
    opened.supervisor = supervisor;
    assert.equal((supervisor.bootstrapReceipt() as { outcome: string }).outcome, "applied");
    for (const center of [false, true]) {
      const binding = localDefaultBinding(auth);
      const result = await supervisor.request<{ outcome: string; authorizationDecision: { outcome: string } }>(
        "run",
        {
          action: { kind: "task-create", taskId: `task-tls-${center}`, title: "Trusted worker" },
        },
        {
          ...binding,
          keycloakAuthorization: {
            ...binding.keycloakAuthorization,
            ...(center ? { center: async () => ({ ...selected, provider, accessToken: "center-token" }) } : {}),
          },
        },
      );
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      assert.equal(result.authorizationDecision.outcome, "allowed");
    }
    const push = await supervisor.request<{ outcome: string; authorizationDecision: { outcome: string } }>(
      "run",
      {
        action: { kind: "task-push", taskId: "task-tls-false" },
      },
      localDefaultBinding(auth),
    );
    assert.equal(push.authorizationDecision.outcome, "allowed", JSON.stringify(push));
    assert.ok(
      realm.seen.some(({ body }) => new URLSearchParams(body).get("permission")?.endsWith("#task-push")),
      "task push reaches UMA authorization before its missing-worktree domain rejection",
    );
    assert.ok(
      realm.seen.some(({ path: endpoint }) => endpoint.includes("/policy/evaluate")),
      "center credential revived in worker",
    );
  });
}

for (const trusted of [true, false]) {
  test(`real HTTPS OIDC authority preserves trust and certificate diagnostics: ${trusted}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-tls-")),
      realm = await tlsRealm(root),
      userRoot = path.join(root, "user"),
      issuer = `${realm.url}/realms/harness`,
      authority = {
        url: realm.url,
        realm: realm.realm,
        clientId: realm.clientId,
        certificate: trusted ? realm.certificate : realm.wrongCa,
        servername: realm.servername,
      },
      token = realm.keycloak.account("tls-person");
    t.after(async () => {
      await realm.close();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
    writeFileSync(path.join(userRoot, "rbac", "config.json"), JSON.stringify({ mode: "external", ...authority }));
    writeFileSync(path.join(userRoot, "rbac", "center-client-secret"), "secret");
    managedRbacSessionStore(userRoot, issuer, realm.realm).write(
      JSON.stringify({
        schema: "harness-oidc-session/v3",
        issuer,
        authority,
        accessToken: token,
        subject: "tls-person",
        personId: "tls-person",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    realm.keycloak.permit(
      "tls-person",
      "tls-repo",
      policyActionDeclarations().map(({ policyAction }) => policyAction),
    );
    const service = createIdentitySession(userRoot);
    if (!trusted) {
      await assert.rejects(service.bind({ transportKind: "unix-socket" }), { code: "keycloak_tls_certificate_error" });
      await assert.rejects(service.center(), { code: "keycloak_tls_certificate_error" });
      // Bypass discovery to prove a failing refresh also surfaces the TLS diagnosis.
      oidcCenterSelections(userRoot).write(undefined, { issuer, authority });
      managedRbacSessionStore(userRoot, issuer, realm.realm).write(
        JSON.stringify({
          schema: "harness-oidc-session/v3",
          issuer,
          authority,
          accessToken: token,
          refreshToken: token,
          subject: "tls-person",
          personId: "tls-person",
          expiresAt: 1,
          sessionExpiresAt: null,
        }),
      );
      await assert.rejects(service.bind({ transportKind: "unix-socket" }), { code: "keycloak_tls_certificate_error" });
      await assert.rejects(service.requireSession(), { code: "keycloak_tls_certificate_error" });
      return;
    }
    const bound = await service.bind({ transportKind: "unix-socket" }),
      binding = localDefaultBinding(bound),
      answer = globalThis.fetch,
      observed: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      observed.push(String(input instanceof Request ? input.url : input));
      return answer(input, init);
    }) as typeof fetch;
    let result: Awaited<ReturnType<typeof evaluateKeycloakPerson>>;
    try {
      result = await evaluateKeycloakPerson({
        credential: binding.keycloakAuthorization!,
        personId: "tls-person",
        action: "task-push",
        resource: { kind: "repository", repoId: "tls-repo" },
      });
    } finally {
      globalThis.fetch = answer;
    }
    assert.equal(result.outcome, "allowed");
    // The evaluation rebinds to the current global fetch, so a post-open interceptor sees the
    // request while the authority CA and SNI still decide whether it succeeds.
    assert.ok(observed.length > 0, "authorization follows a post-open global fetch interceptor");
    assert.equal(bound.oidcPrincipal?.authority.certificate, realm.certificate);
    assert.equal(bound.oidcPrincipal?.authority.servername, realm.servername);
    for (const mode of ["external", "managed"] as const) {
      const defaultProvider = createAuthorizationProvider({
        ...authority,
        mode,
        resourceServerClientId: realm.clientId,
      });
      assert.equal(
        (
          await defaultProvider.authorize({
            userAccessToken: token,
            action: "task-push",
            resource: { kind: "repository", repoId: "tls-repo" },
          })
        ).outcome,
        "allowed",
        "omitted fetchPort stays TLS-aware",
      );
    }
    const center = await service.center();
    assert.equal(center.certificate, realm.certificate);
    assert.equal(
      (
        await center.provider.authorize({
          userAccessToken: token,
          action: "task-push",
          resource: { kind: "repository", repoId: "tls-repo" },
        })
      ).outcome,
      "allowed",
    );
  });
}
