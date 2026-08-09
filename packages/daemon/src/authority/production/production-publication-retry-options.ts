import type { DaemonLogService } from "@harness-anything/application";
import type { RetryBudgetSignal } from "../../observability/visible-retry-budget.ts";
import { publicationRetryOptions } from "./publication-evidence.ts";

interface ProductionPublicationRetryVisibility {
  readonly daemonLogService?: DaemonLogService;
  readonly onPublicationRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
}

export function productionPublicationRetryOptions(
  visibility: ProductionPublicationRetryVisibility,
  repo: { readonly repoId: string; readonly canonicalRoot: string }
): ReturnType<typeof publicationRetryOptions> {
  return visibility.onPublicationRetryBudgetSignal
    ? { onRetryBudgetSignal: visibility.onPublicationRetryBudgetSignal }
    : publicationRetryOptions(visibility.daemonLogService, repo);
}
