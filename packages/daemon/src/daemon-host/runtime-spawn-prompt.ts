import { scheduleMissionWithOutcomeProtocol } from "./schedule-runtime-outcome.ts";

const dispatchIdPromptTemplateToken = "__HARNESS_DISPATCH_ID__";

export function dispatchPromptTemplate(prompt: string, dispatchId: string): string {
  return prompt.replaceAll(dispatchId, dispatchIdPromptTemplateToken);
}

export function renderDispatchPrompt(prompt: string, dispatchId: string, scheduled: boolean): string {
  const rendered = scheduled ? scheduleMissionWithOutcomeProtocol(prompt) : prompt;
  return rendered.replaceAll(dispatchIdPromptTemplateToken, dispatchId);
}
