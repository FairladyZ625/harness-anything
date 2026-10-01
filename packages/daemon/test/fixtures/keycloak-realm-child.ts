// Child entry for spawnKeycloak: serves the fixture realm and applies control messages from its parent.
import { applyRealmControl, serveKeycloak } from "../keycloak.fixtures.ts";

const served = await serveKeycloak();
process.on("message", (message) => {
  process.send!({ result: applyRealmControl(served.keycloak, message as Parameters<typeof applyRealmControl>[1]) });
});
process.on("disconnect", () => process.exit(0));
process.send!({ url: served.url });
