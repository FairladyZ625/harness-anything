import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Host-owned process inspection and request-driven recovery share one lifecycle boundary. */
export const managedIdentityPolicy = {
  id: "managed-identity-lifecycle",
  ownerRef: "host",
  unit: "milliseconds / in-flight resume",
  bounds:
    "Process inspection and Windows tree termination each have a 5000ms deadline. Failed startup resumes are retried by a later request; at most one resume is in flight, with no autonomous retry loop. Existing managed-child restart backoff is unchanged.",
  defaultValue: { timeoutMs: 5_000 },
  version: 1,
  scope: "managed identity process ownership inspection, tree termination and daemon startup recovery",
  reason:
    "Reclaim only processes proven to belong to the configured managed runtime; release a rejected startup promise so a transient bind failure cannot permanently disable authentication.",
  fixtures: [
    "packages/daemon/test/managed-rbac-process-orphan.integration.test.ts",
    "packages/daemon/test/daemon-host-keycloak-resume.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedIdentityPolicy.defaultValue.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
      route: "daemon:bin",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

/** The provider owns its version marker and shapes; the registry binds only their exact source. */
export const builtinAuthorizationContractPolicy = {
  id: "builtin-authorization-contract",
  ownerRef: "host",
  unit: "provider policy version marker",
  bounds: "The builtin adapter owns the builtin-policy@1 protocol marker; it is not a quota or an authorization grant.",
  defaultValue: 1,
  version: 1,
  scope: "Builtin authorization decision provenance",
  reason:
    "Classify a policy-shaped protocol identifier while leaving provider implementation and provider-specific shapes in their existing remediation boundary.",
  fixtures: [
    "packages/daemon/test/builtin-identity-provider.test.ts",
    "tools/gates/test/authorization-provider-boundary.test.mjs",
    "tools/gates/test/ontology-closure.test.mjs",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/authorization-builtin:packages/authorization-builtin/src/builtin-policy-adapter.ts#BuiltinPolicyAdapter.policyRef:196006167e2921ac6350b76ee3660eb2",
      route: "BuiltinPolicyAdapter.policyRef",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const managedClientScopePolicy = {
  id: "identity-client-scope",
  ownerRef: "host",
  unit: "identity provider client full-scope grant",
  bounds:
    "Managed and execution clients keep fullScopeAllowed false; node principals are admitted only for the same client shape.",
  defaultValue: { fullScopeAllowed: false },
  version: 1,
  scope: "identity provider client authorization scopes",
  reason: "Keep provider client scopes least-privileged across managed, node and execution clients.",
  fixtures: [
    "packages/daemon/test/keycloak-policy-adapter.test.ts",
    "packages/daemon/test/oidc-fleet-principal.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedClientScopePolicy.defaultValue.fullScopeAllowed:0da8b12f7d528ac733ac35cc5adba51b",
      route: "default-full-scope",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-execution-credential.ts#issueRuntimeExecutionCredential.conflict.fullScopeAllowed:0da8b12f7d528ac733ac35cc5adba51b",
      route: "execution-client",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-policy-adapter.ts#KeycloakPolicyAdapter.syncLoginClients.body.fullScopeAllowed:0da8b12f7d528ac733ac35cc5adba51b",
      route: "sync-login-clients",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-policy-adapter.ts#nodeClientBody.fullScopeAllowed:0da8b12f7d528ac733ac35cc5adba51b",
      route: "node-client",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:6304026457eb14eba6d97cc059e37043",
      route: "fleet-replica-client",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identityLoginMapperPolicy = {
  id: "identity-login-mappers",
  ownerRef: "host",
  unit: "OIDC claim mapping",
  bounds:
    "Map the Harness person attribute to access, introspection and userinfo tokens; preserve the existing mapper values.",
  defaultValue: {
    personAttribute: "harness_person_id",
    claimName: "harness_person_id",
    accessTokenClaim: true,
    introspectionTokenClaim: true,
    userinfoTokenClaim: true,
  },
  version: 1,
  scope: "identity provider login mapper configuration",
  reason: "Keep the identity claim consumed by OIDC admission consistent with the provider's installed mappers.",
  fixtures: [
    "packages/daemon/test/keycloak-policy-adapter.test.ts",
    "packages/daemon/test/oidc-session-service.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityLoginMapperPolicy.defaultValue.claimName:df5d3f6dbc599ec6e13f46e22e1f4900",
      route: "default-person-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityLoginMapperPolicy.defaultValue.accessTokenClaim:c2aa06aa98565695e428516e531a1d58",
      route: "default-access-token-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityLoginMapperPolicy.defaultValue.introspectionTokenClaim:64fe2b3e679dba42702d288cdfb6d81c",
      route: "default-introspection-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityLoginMapperPolicy.defaultValue.userinfoTokenClaim:a0e9b418deb6b072d884a2c3b16804cc",
      route: "default-userinfo-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-login-client.ts#keycloakLoginMappers.config.claim.name:d239014622149bbe0f7db8ca0d9b995f",
      route: "person-claim-name",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-login-client.ts#keycloakLoginMappers.config.access.token.claim:82bb09e63cb6fe2fde78270ec8a305c0",
      route: "access-token-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-login-client.ts#keycloakLoginMappers.config.introspection.token.claim:0aecfe3f7a8165ac9c336afd5dd20bd0",
      route: "introspection-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-login-client.ts#keycloakLoginMappers.config.userinfo.token.claim:42a6b021ba7b43f146e33f28f9a6c027",
      route: "userinfo-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-login-client.ts#keycloakLoginMappers.config.access.token.claim:82bb09e63cb6fe2fde78270ec8a305c0:2",
      route: "audience-access-token-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-login-client.ts#keycloakLoginMappers.config.introspection.token.claim:0aecfe3f7a8165ac9c336afd5dd20bd0:2",
      route: "audience-introspection-claim",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const managedAuthorizationSettingsPolicy = {
  id: "identity-authorization-settings",
  ownerRef: "host",
  unit: "identity provider realm and authorization strategy",
  bounds:
    "Preserve the managed realm's registration, email-login, enforcement and decision settings and positive user grant logic.",
  defaultValue: {
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    policyEnforcementMode: "ENFORCING",
    decisionStrategy: "AFFIRMATIVE",
    userPolicyLogic: "POSITIVE",
  },
  version: 1,
  scope: "identity provider-managed realm authorization defaults",
  reason: "Keep bootstrap and later grant writes on the same fail-closed policy configuration.",
  fixtures: [
    "packages/daemon/test/keycloak-policy-adapter.test.ts",
    "packages/daemon/test/managed-rbac-service.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedAuthorizationSettingsPolicy.defaultValue.registrationAllowed:bd50abd830a8f2d418edc9d5401fa25e",
      route: "default-registration-policy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedAuthorizationSettingsPolicy.defaultValue.loginWithEmailAllowed:c058058203b8e412bb9408fa460cdd66",
      route: "default-email-login-policy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedAuthorizationSettingsPolicy.defaultValue.policyEnforcementMode:fff53ec11a2eed21ae46e34792a17af3",
      route: "default-enforcement-mode",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedAuthorizationSettingsPolicy.defaultValue.decisionStrategy:88b738b4062a8719fa16ab9a70be5f4a",
      route: "default-decision-strategy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedAuthorizationSettingsPolicy.defaultValue.userPolicyLogic:6552919aa5f7c737211cdb25402c35c3",
      route: "default-user-policy-logic",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-policy-adapter.ts#KeycloakPolicyAdapter.writeGrant.policyBody:19ef13564e5a566b8307c1dd41a33282",
      route: "write-user-policy",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-policy-adapter.ts#KeycloakPolicyAdapter.writeGrant.permissionBody.decisionStrategy:88b738b4062a8719fa16ab9a70be5f4a",
      route: "write-scope-permission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService.realm.registrationAllowed:bd50abd830a8f2d418edc9d5401fa25e",
      route: "managed-realm-registration",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService.realm.loginWithEmailAllowed:c058058203b8e412bb9408fa460cdd66",
      route: "managed-realm-email-login",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService.realm.clients.authorizationSettings.policyEnforcementMode:fff53ec11a2eed21ae46e34792a17af3",
      route: "managed-realm-enforcement",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService.realm.clients.authorizationSettings.decisionStrategy:88b738b4062a8719fa16ab9a70be5f4a",
      route: "managed-realm-decision",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identityAdapterContractPolicy = {
  id: "identity-policy-contract",
  ownerRef: "host",
  unit: "provider policy contract version",
  bounds: "The adapter advertises the existing provider-owned contract version 1 marker.",
  defaultValue: 1,
  version: 1,
  scope: "identity provider policy provenance",
  reason: "Keep the provider's policy contract identity explicit at the shared ontology boundary.",
  fixtures: ["packages/daemon/test/keycloak-policy-adapter.test.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-policy-adapter.ts#KeycloakPolicyAdapter.policyRef:09dbf9fe210fa43b1527a87af69e2f51",
      route: "KeycloakPolicyAdapter.policyRef",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identityAdminNotFoundPolicy = {
  id: "identity-admin-not-found",
  ownerRef: "host",
  unit: "explicit HTTP 404 tolerance",
  bounds: "A missing object is tolerated only when the caller opts in; all other non-success responses remain errors.",
  defaultValue: { allowNotFoundByDefault: false, toleratedStatus: 404 },
  version: 1,
  scope: "identity provider Admin REST deletion and lookup requests",
  reason: "Keep absence idempotent only at call sites that explicitly declare it expected.",
  fixtures: [
    "packages/daemon/test/keycloak-policy-adapter.test.ts",
    "packages/daemon/test/oidc-session-service.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityAdminNotFoundPolicy.defaultValue.allowNotFoundByDefault:6cc0c390848c4670238b182ccac2e826",
      route: "default-not-found-tolerance",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityAdminNotFoundPolicy.defaultValue.toleratedStatus:3fc1faad311449ce3ba64880cbc03ab6",
      route: "default-tolerated-status",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-policy-adapter.ts#KeycloakPolicyAdapter:beeec620dd307bea6e8a1aa6cafde6a1",
      route: "policy-adapter-request",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-session-service.ts#OidcSessionService:c62cda2f2395b74884d702e41333b154",
      route: "oidc-session-request",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identitySessionLifetimePolicy = {
  id: "identity-session-lifetime",
  ownerRef: "host",
  unit: "seconds",
  bounds:
    "Default idle lifetime is six hours, minimum is five minutes, maximum is one year; offline and refresh-token defaults remain provider-compatible.",
  defaultValue: {
    defaultSeconds: 21_600,
    minimumSeconds: 300,
    maximumSeconds: 31_536_000,
    offlineSessionIdleTimeout: 7_776_000,
    offlineSessionMaxLifespanEnabled: false,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
  },
  version: 1,
  scope: "identity provider SSO session lifetime and realm representation",
  reason: "Declare the existing session lifetime bounds and required realm shape in the shared identity policy.",
  fixtures: ["packages/daemon/test/writer-preset-session-lifetime.test.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identitySessionLifetimePolicy.defaultValue.offlineSessionIdleTimeout:cecd0da6e96e9e0495d563a1e9007742",
      route: "default-offline-session-lifetime",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/keycloak-session-lifetime.ts#readRealm:2332317e09298fda487cf343418da5ab",
      route: "read-session-lifetime",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identityDatabaseProcessPolicy = {
  id: "identity-postgres-orphan-stop",
  ownerRef: "host",
  unit: "milliseconds",
  bounds: "Orphan postmaster status checks time out after 5000ms and orderly stop requests after 35000ms.",
  defaultValue: { statusTimeoutMs: 5_000, stopTimeoutMs: 35_000 },
  version: 1,
  scope: "Managed PostgreSQL orphan cleanup",
  reason: "Keep the existing bounded process inspection and shutdown contract for managed PostgreSQL only.",
  fixtures: ["packages/daemon/test/managed-rbac-postgres-orphan.integration.test.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityDatabaseProcessPolicy.defaultValue.statusTimeoutMs:fb6787304c3d10655e026dc906c90402",
      route: "default-postmaster-status-timeout",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityDatabaseProcessPolicy.defaultValue.stopTimeoutMs:76e287c928d236ffcef57dc3bc8ab317",
      route: "default-postmaster-stop-timeout",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-postgres-orphan.ts#stopManagedPostgresOrphan.status.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
      route: "postmaster-status",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-postgres-orphan.ts#stopManagedPostgresOrphan.stopped.timeoutMs:1dc96c8131679014f87d9a57a5ed15c7",
      route: "postmaster-stop",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identityHealthProbePolicy = {
  id: "identity-health-probe",
  ownerRef: "host",
  unit: "milliseconds / attempts",
  bounds:
    "PostgreSQL single-user password application times out at 30000ms; realm readiness probes every 250ms up to 120 attempts on Unix or 720 on Windows.",
  defaultValue: {
    postgresPasswordTimeoutMs: 30_000,
    readinessAttempts: { default: 120, win32: 720 },
    probeIntervalMs: 250,
  },
  version: 1,
  scope: "Managed identity provider health and PostgreSQL password operation budgets",
  reason: "Keep startup bounded and preserve transport failure classification after readiness probes.",
  fixtures: [
    "packages/daemon/test/managed-rbac-service.test.ts",
    "packages/daemon/test/managed-rbac-supervision.integration.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityHealthProbePolicy.defaultValue.postgresPasswordTimeoutMs:fb04bdc1a1d6f4eb640ac604bf0c9ff5",
      route: "default-postgres-password-timeout",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityHealthProbePolicy.defaultValue.readinessAttempts:df6c5bf9d625785e8156b8a024903d02",
      route: "default-readiness-attempts",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
      route: "postgres-password-timeout",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
      route: "realm-readiness-attempts",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/managed-rbac-service.ts#ManagedRbacService:444a7d4a5f08c010d3afc5453b7b2c74",
      route: "readiness-transport-failure",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const identityFleetPrincipalPolicy = {
  id: "identity-fleet-principal-admission",
  ownerRef: "host",
  unit: "OIDC token claim and identity provider client admission set",
  bounds:
    "Require an active, unexpired token for the configured issuer and audience; bind node replicas to their enabled service account and registered node, and human principals to an enabled person account.",
  defaultValue: {
    personClaim: "harness_person_id",
    authorizedPartyClaim: "azp",
    nodeClientPrefix: "harness-node-",
    activeClaim: "active",
    expiryClaim: "exp",
    issuerClaim: "iss",
    audienceClaim: "aud",
    subjectClaim: "sub",
    scopeClaim: "scope",
    activeValue: true,
  },
  version: 1,
  scope: "Fleet replica and human OIDC principal admission",
  reason:
    "Keep the principal allow-set and provider claim names explicit while preserving existing rejection behavior.",
  fixtures: [
    "packages/daemon/test/oidc-fleet-principal.test.ts",
    "packages/daemon/test/oidc-edge-login-trust.integration.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.personClaim:14ab0d267c8c24ca348ea3f839849f67",
      route: "default-person-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.authorizedPartyClaim:55b3e1b06c3127ab15b307d685c65d3d",
      route: "default-authorized-party-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.activeClaim:6ffe09ece322841ae94e80b784c02bdc",
      route: "default-active-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.expiryClaim:53719f44a66f2b4fcbbf08a712917d94",
      route: "default-expiry-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.issuerClaim:887c0eaf89f93790d9b3a9b0132e1814",
      route: "default-issuer-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.audienceClaim:207989dff7e42690fa0c93b90fa83899",
      route: "default-audience-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.subjectClaim:b7f68a1feaae13bcbf59723343f9730c",
      route: "default-subject-claim",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#identityFleetPrincipalPolicy.defaultValue.scopeClaim:e86535386bd2276cbd7edbd8e0e68681",
      route: "default-scope-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:621e48fb349350154c1a3a75b16ce355",
      route: "replica-person-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:dd6d729651ac7208412449f017111cc8",
      route: "replica-authorized-party-prefix",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:24ec1782c6a1e9389ec49c4e4dcb2931",
      route: "replica-active-client",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica.expiresAt:e045af9ed32118f09369d341cb005598",
      route: "replica-expiry",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:725386cf6e3d658dee8d3f3392235611",
      route: "replica-issuer-audience-subject",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:30e29ddea8bc2a6842b262d4145bcb11",
      route: "replica-service-account-user",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman.expiresAt:e045af9ed32118f09369d341cb005598",
      route: "human-expiry",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman:fd6a2895863bd61c95ddcc5a58c26b31",
      route: "human-claim-allow-set",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman:28e3b4de3f98154bf1fada85841cbbe7",
      route: "human-user-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman.oidcPrincipal.scopes:1ac6358cc2420baea37828e3a9c321a1",
      route: "human-scope-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:3c00292c99094526975cfc12864891d3",
      route: "replica-subject-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:e649db206808c65c1e8d77dfabf5ea82",
      route: "replica-issuer-audience-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica.expiresAt:9fd1608d86fb77a3076f5360af0fd07c",
      route: "replica-expiry-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:9dce64657266ee58331f551e1e9b66de",
      route: "replica-node-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:5f39bfe29abb32fd1da1912d59bf7d88",
      route: "replica-client-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman.expiresAt:9fd1608d86fb77a3076f5360af0fd07c",
      route: "human-expiry-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman:293755ba19218f23fd1b9a5f7037d496",
      route: "human-principal-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman.oidcPrincipal.scopes:8be163445935bdbf95d76f1519487c09",
      route: "human-scopes-claim",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:3b6699eabdc29a89c26c0898e3b00b73",
      route: "replica-person-claim-exclusion",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetReplica:728baf209d0fdcef106f02b8c303d3b2",
      route: "replica-node-client-rejection",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman:4cc1983013e16bb63d078be74ec64880",
      route: "human-token-admission",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak:packages/authorization-keycloak/src/oidc-fleet-principal.ts#verifyFleetHuman:e637fab66b81463bde5b27856ed33dfe",
      route: "human-user-admission",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonRuntimeInstancePolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier:591f860a7311dfba12b25e2822ac2887",
    "packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier",
    "if (models.includes(requested)) return { model: requested, tier: 3 };",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier:591f860a7311dfba12b25e2822ac2887:2",
    "packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier",
    "if (models.includes(intent)) return { model: intent, tier: 3 };",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier:b8db69a7e03d2d7a150ced68992f731b",
    "packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier",
    "if (caseInsensitiveRequest !== undefined) return { model: caseInsensitiveRequest, tier: 2 };",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier:b8db69a7e03d2d7a150ced68992f731b:2",
    "packages/daemon/src/agent-runtime-contract.ts#agentRuntimeModelResolution.tier",
    "if (caseInsensitive !== undefined) return { model: caseInsensitive, tier: 2 };",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-credential-port.ts#credentialLookupTimeoutMs:68a2e149fda5327b1cec5d5282dd05fd",
    "packages/daemon/src/agent-runtime-credential-port.ts#credentialLookupTimeoutMs",
    "const credentialLookupTimeoutMs = 10_000;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-installation-discovery.ts#discoverRuntimeInstallations.discovered.version.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
    "packages/daemon/src/agent-runtime-installation-discovery.ts#discoverRuntimeInstallations.discovered.version.timeoutMs",
    "timeoutMs: 5_000,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-installation-discovery.ts#discoverRuntimeModelCatalog.discovered.output.timeoutMs:056c7dce56e510cebb035d21bd434840",
    "packages/daemon/src/agent-runtime-installation-discovery.ts#discoverRuntimeModelCatalog.discovered.output.timeoutMs",
    "timeoutMs: 8_000,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-launch-config.ts#providerSubscriptionReadiness.result.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/agent-runtime-launch-config.ts#providerSubscriptionReadiness.result.timeoutMs",
    "timeoutMs: 30_000,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-launch-config.ts#secureRuntimeBaseUrl:147f04ebad7283553bd2171f476cd0d3",
    "packages/daemon/src/agent-runtime-launch-config.ts#secureRuntimeBaseUrl",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-web-search.ts#readCodexManagedPolicyTexts.timeoutMs:a883cef9fc71b79b83aa77c3644939a5",
    "packages/daemon/src/agent-runtime-web-search.ts#readCodexManagedPolicyTexts.timeoutMs",
    "{ timeoutMs: 2_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/agent-runtime-web-search.ts#runtimeWebSearchPolicyConflict.texts:8995ece3ef79ebae08951a75593418a0",
    "packages/daemon/src/agent-runtime-web-search.ts#runtimeWebSearchPolicyConflict.texts",
    'const texts = typeof policyTexts === "function" ? await policyTexts() : policyTexts;',
  ],
] as const;
