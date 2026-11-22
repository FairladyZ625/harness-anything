# @harness-anything/authorization

Harness Anything authorization providers and desktop integration.

- `./builtin` provides policy, RBAC, and local sessions for a single-machine installation.
- `./keycloak` provides managed RBAC and OIDC sessions for team installations.
- `./gui` provides desktop IPC, presentation, and UI contracts.
- `./keycloak-gui` provides React views for access management and OIDC.

React is an optional peer for the desktop views. The server entry points run
with the kernel and Node.js. The npm tarball contains compiled JavaScript and
TypeScript declarations for the exported subpaths.

License: AGPL-3.0-or-later.
