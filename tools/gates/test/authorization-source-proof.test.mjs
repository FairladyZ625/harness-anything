// harness-test-tier: contract
import test from "node:test";
import { registerScenarios } from "./authorization-source-proof-scenarios.mjs";

registerScenarios(1, test);
