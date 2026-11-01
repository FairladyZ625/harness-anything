# Built-in identity provider

Harness Anything uses a local identity provider by default. First startup writes only `rbac/config.json` and `rbac/builtin-state.json` under the user root; it does not download Java, Keycloak, or PostgreSQL. The center daemon's serialized write queue owns local accounts, roles, teams, node registrations, and sessions. Passwords use Node's `crypto.scrypt`; login and node credentials are opaque values from `randomBytes`/`randomUUID`.

The built-in provider covers local accounts, roles, node join, and sessions. It does not provide SSO or an external directory. When multiple edges join or log in concurrently, the center state is the sole authority; an edge receives a center-issued node credential and session copy rather than creating an authorization store.

To use an existing Keycloak realm, switch explicitly:

```bash
ha bootstrap --mode external --url https://identity.example.com \
  --realm fleet --client-id harness-center --client-secret-stdin < ./client-secret
```

Switching preserves local state but does not silently migrate passwords, roles, or nodes. Create the corresponding accounts and grants in the Keycloak realm, then run the normal login command. The daemon, GUI, and authorization ports remain the same; switching back requires an explicit `mode: builtin` configuration and a new login.
