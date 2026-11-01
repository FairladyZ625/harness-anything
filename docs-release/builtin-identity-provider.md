# Built-in identity provider

Harness Anything uses a local identity provider by default. First startup writes only `rbac/config.json` and `rbac/builtin-state.json` under the user root; it does not download Java, Keycloak, or PostgreSQL. The built-in provider is deliberately single-machine and single-user: it supports the first local administrator, that user's session, and local repository authorization.

Teams, additional accounts, group and grant administration, node credentials, edge join, Fleet center/edge transport, remote GUI login, and remote session renewal are collaboration features. They are rejected by the built-in provider with an instruction to install the Keycloak plugin. There is no second authorization path. Passwords use Node's `crypto.scrypt`, and local session values are opaque random values.

<a id="keycloak-plugin"></a>

## Keycloak plugin

Install the Keycloak provider package when collaboration is needed:

```bash
npm install --global @harness-anything/authorization-keycloak@0.1.0
```

The package supplies the Keycloak-backed provider. Your deployment still supplies and configures the Keycloak service and realm. The provider keeps the same daemon, GUI, and authorization ports; only the selected identity provider changes.

To use an existing Keycloak realm, switch explicitly:

```bash
ha bootstrap --mode external --url https://identity.example.com \
  --realm fleet --client-id harness-center --client-secret-stdin < ./client-secret
```

Switching does not silently migrate local credentials or authorization. Create the required accounts, roles, and grants in the Keycloak realm, then run the normal login command. Switching back requires an explicit `mode: builtin` configuration and a new local login.
