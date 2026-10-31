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
        "user.attribute": "harness_person_id",
        "claim.name": "harness_person_id",
        "jsonType.label": "String",
        "access.token.claim": "true",
        "introspection.token.claim": "true",
        "userinfo.token.claim": "true",
      },
    },
    {
      name: "center-audience",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: {
        "included.client.audience": resourceServerClientId,
        "access.token.claim": "true",
        "introspection.token.claim": "true",
      },
    },
  ];
}
