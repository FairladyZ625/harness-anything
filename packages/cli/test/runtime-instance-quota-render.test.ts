// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("CLI receipt renderer displays subscription quota columns and reset windows for list and show", () => {
  const listReceipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-instance-list",
    outcome: "applied",
    summary: [
      "ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tCREDENTIAL SOURCE\tAVAILABLE MODELS\tLOGIN STATUS\tPERMISSION MODE\tMCP POLICY\tQUOTA",
      "claude-max\tClaude Max\tclaude\tclaude-opus-5-5\tenabled\tsubscription\tinstance\tclaude-opus-5-5\tready\tbypass\tdisabled\t[max] 5h 82% (resets 2026-11-21T15:00:00.000Z), 7d 55% (resets 2026-11-28T00:00:00.000Z)",
    ].join("\n"),
  };
  const showReceipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-instance-show",
    outcome: "applied",
    summary: [
      "runtime-instance-show: claude-max",
      "tier: 1",
      "models: claude-opus-5-5",
      "availableModels: claude-opus-5-5",
      "credentialSource: instance",
      "auth: ready",
      "permissionMode: bypass",
      "mcpPolicy: disabled",
      "quota: [max] 5h 82% (resets 2026-11-21T15:00:00.000Z), 7d 55% (resets 2026-11-28T00:00:00.000Z)",
    ].join("\n"),
  };

  const renderedList = renderCliReceipt(listReceipt);
  assert.equal(renderedList.stream, "stdout");
  assert.match(renderedList.text, /\tQUOTA\n/u);
  assert.match(renderedList.text, /5h 82% \(resets 2026-11-21T15:00:00\.000Z\)/u);

  const renderedShow = renderCliReceipt(showReceipt);
  assert.equal(renderedShow.stream, "stdout");
  assert.match(renderedShow.text, /quota: \[max\] 5h 82% \(resets 2026-11-21T15:00:00\.000Z\)/u);
});
