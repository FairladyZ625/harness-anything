// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { renderEvidencePayload } from "../src/repo-cell-evidence.ts";

test("renderEvidencePayload renders expected-version on agent and squad inspection receipts", () => {
  const agentInspection = {
    schema: "agent-inspection/v1",
    workspaceRevision: 188386,
    agent: { id: "terra", name: "Terra" },
    status: "ready",
    watermark: 198646,
    sourceRevision: 198646,
  };
  const renderedAgent = renderEvidencePayload(agentInspection);
  assert.match(renderedAgent, /expected-version=188386/u);
  assert.match(renderedAgent, /schema=agent-inspection\/v1 {2}expected-version=188386 {2}workspaceRevision=188386/u);

  const squadInspection = {
    schema: "squad-inspection/v1",
    workspaceRevision: 185782,
    squad: { id: "debug-squad", name: "Debug Squad" },
    status: "ready",
    watermark: 198657,
    sourceRevision: 198657,
  };
  const renderedSquad = renderEvidencePayload(squadInspection);
  assert.match(renderedSquad, /expected-version=185782/u);
  assert.match(renderedSquad, /schema=squad-inspection\/v1 {2}expected-version=185782 {2}workspaceRevision=185782/u);

  const otherPayload = {
    schema: "other-entity/v1",
    workspaceRevision: 42,
    status: "ready",
  };
  const renderedOther = renderEvidencePayload(otherPayload);
  assert.doesNotMatch(renderedOther, /expected-version/u);
});
