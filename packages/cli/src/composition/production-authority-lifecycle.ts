import {
  createProductionAuthorityLifecycle as createProductionAuthorityLifecycleCore
} from "@harness-anything/daemon";
import { productionAuthorityHostServices } from "./production-authority-host-services.ts";

type ProductionAuthorityLifecycleInput = Omit<
  Parameters<typeof createProductionAuthorityLifecycleCore>[0],
  "hostServices"
>;

/** CLI composition supplies presentation/normalization capabilities to the daemon-owned core. */
export function createCliProductionAuthorityLifecycle(input: ProductionAuthorityLifecycleInput) {
  return createProductionAuthorityLifecycleCore({
    ...input,
    hostServices: productionAuthorityHostServices
  });
}
