// harness-test-tier: integration
import test from "node:test";
import { residentReadoptionScenarios, residentReadoptionCase } from "./fixtures/resident-readoption-cases.fixture.ts";

for (const scenario of residentReadoptionScenarios.filter(
  (scenario) => !(scenario.supervised && !scenario.failDeadline),
)) {
  const entry = residentReadoptionCase(scenario);
  test(entry.name, entry.options, entry.run);
}
