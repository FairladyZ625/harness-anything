// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { managedKeycloakListenerEnvironment } from "../../src/keycloak/managed-rbac-service.ts";

const listener = {
  certificateFile: "D:\\fleet-dev\\center-user\\rbac\\listener.pem",
  certificateKeyFile: "D:\\fleet-dev\\center-user\\rbac\\listener-key.pem",
} as const;

test("managed Keycloak certificate paths use forward slashes on Windows", () => {
  assert.deepEqual(managedKeycloakListenerEnvironment(listener, "win32"), {
    KC_HTTPS_CERTIFICATE_FILE: "D:/fleet-dev/center-user/rbac/listener.pem",
    KC_HTTPS_CERTIFICATE_KEY_FILE: "D:/fleet-dev/center-user/rbac/listener-key.pem",
  });
});

test("managed Keycloak certificate paths preserve POSIX values", () => {
  const posixListener = {
    certificateFile: "/srv/fleet-dev/center-user/rbac/listener.pem",
    certificateKeyFile: "/srv/fleet-dev/center-user/rbac/listener-key.pem",
  } as const;

  assert.deepEqual(managedKeycloakListenerEnvironment(posixListener, "linux"), {
    KC_HTTPS_CERTIFICATE_FILE: "/srv/fleet-dev/center-user/rbac/listener.pem",
    KC_HTTPS_CERTIFICATE_KEY_FILE: "/srv/fleet-dev/center-user/rbac/listener-key.pem",
  });
});
