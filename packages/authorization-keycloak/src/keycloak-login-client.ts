import { identityLoginMapperPolicy } from "@harness-anything/kernel/internal/domain/managed-identity-policy.ts";

/** Standard Keycloak client settings shared by desktop/CLI and registered node login. */
export const keycloakLoginAttributes = Object.freeze({
  "oauth2.device.authorization.grant.enabled": "true",
  "pkce.code.challenge.method": "S256",
});

export function keycloakLoginMappers(resourceServerClientId: string) {
  return [
    {
      name: "harness-person-id",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      config: {
        "user.attribute": identityLoginMapperPolicy.defaultValue.personAttribute,
        "claim.name": identityLoginMapperPolicy.defaultValue.claimName,
        "jsonType.label": "String",
        "access.token.claim": String(identityLoginMapperPolicy.defaultValue.accessTokenClaim),
        "introspection.token.claim": String(identityLoginMapperPolicy.defaultValue.introspectionTokenClaim),
        "userinfo.token.claim": String(identityLoginMapperPolicy.defaultValue.userinfoTokenClaim),
      },
    },
    {
      name: "center-audience",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: {
        "included.client.audience": resourceServerClientId,
        "access.token.claim": String(identityLoginMapperPolicy.defaultValue.accessTokenClaim),
        "introspection.token.claim": String(identityLoginMapperPolicy.defaultValue.introspectionTokenClaim),
      },
    },
  ];
}
