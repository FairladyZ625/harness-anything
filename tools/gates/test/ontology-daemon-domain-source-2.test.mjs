// harness-test-tier: contract
import test from "node:test";
import { registerScenarios } from "./ontology-daemon-domain-source-scenarios.mjs";

registerScenarios(2, test);
