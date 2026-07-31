import { registerCurrentTestIsolation } from "./node-test-isolation-registry.mjs";

try {
  await registerCurrentTestIsolation();
} catch {
  // Stall diagnostics are best-effort and never own test module loading.
}
