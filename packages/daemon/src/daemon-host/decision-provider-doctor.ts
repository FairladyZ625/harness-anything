import path from "node:path";
import type { DecisionProviderRecord } from "@harness-anything/kernel";
import type { DoctorCheck } from "./repo-cell-doctor.ts";

const checkId = "decisions-provider";

/**
 * `ha doctor health` Decisions configuration check. The provider records are machine-local, so the
 * host process supplies them; this function only judges the provider the repository selected.
 * Read-only: it names the model, the failure code, the config file, and the next command without
 * resolving the credential or contacting OpenRouter.
 */
export function decisionProviderDoctorCheck(input: {
  readonly userRoot: string;
  readonly configuredProviderId: string | null;
  readonly listProviders: () => readonly DecisionProviderRecord[];
}): DoctorCheck {
  const configPath = path.join(input.userRoot, "decision-providers.json");
  let providers: readonly DecisionProviderRecord[];
  try {
    providers = input.listProviders();
  } catch (error) {
    return {
      id: checkId,
      status: "fail",
      count: 1,
      summary: `The machine-local Decisions provider file could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      next: `Repair or remove ${configPath}, then rerun ha doctor health.`,
    };
  }
  const providerId = input.configuredProviderId;
  if (providerId === null)
    return {
      id: checkId,
      status: "ok",
      count: 0,
      summary:
        "No Decisions provider is selected for this repository; advisory decision points stay dormant and dispatch settlement uses deterministic defaults.",
      next: "Nothing to do.",
    };
  const provider = providers.find((entry) => entry.providerId === providerId);
  if (!provider)
    return {
      id: checkId,
      status: "fail",
      count: 1,
      summary: `Decisions provider ${providerId} is selected by repository settings but no machine-local provider record exists.`,
      next: `Create it with ha provider create --type decisions --id ${providerId} --name <name> --model <model> --api-key-file <protected-file>, or select another provider in settings. Config: ${configPath}.`,
    };
  if (!provider.enabled)
    return {
      id: checkId,
      status: "fail",
      count: 1,
      summary: `Decisions provider ${providerId} (model ${provider.model}) is selected by repository settings but disabled.`,
      next: `Run ha provider update ${providerId} --enable, then ha provider probe ${providerId}. Config: ${configPath}.`,
    };
  if (provider.probe.state === "failed") {
    const modelUnavailable = provider.probe.code === "decision_model_unavailable",
      next = modelUnavailable
        ? `Run ha provider update ${providerId} --model <available-model>, then ha provider probe ${providerId}. Config: ${configPath}.`
        : provider.probe.code === "provider_credential_unavailable"
          ? `Run ha provider update ${providerId} --api-key-file <protected-file>, then ha provider probe ${providerId}. Config: ${configPath}.`
          : `Run ha provider probe ${providerId} to confirm the cause; if it reports decision_model_unavailable, run ha provider update ${providerId} --model <available-model>. Config: ${configPath}.`;
    return {
      id: checkId,
      status: modelUnavailable ? "fail" : "warn",
      count: 1,
      summary: `Decisions provider ${providerId} (model ${provider.model}) last failed with ${provider.probe.code} at ${provider.probe.checkedAt}; automatic disposition falls back to deterministic defaults.`,
      next,
    };
  }
  if (provider.probe.state === "unknown")
    return {
      id: checkId,
      status: "warn",
      count: 1,
      summary: `Decisions provider ${providerId} (model ${provider.model}) has not been probed, so its model and credential are unverified.`,
      next: `Run ha provider probe ${providerId}. Config: ${configPath}.`,
    };
  return {
    id: checkId,
    status: "ok",
    count: 0,
    summary: `Decisions provider ${providerId} (model ${provider.model}) was ready at ${provider.probe.checkedAt}.`,
    next: "Nothing to do.",
  };
}
