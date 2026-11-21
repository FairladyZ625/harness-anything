// harness-test-tier: contract
import test from "node:test";
import { registerScenarios } from "./ontology-daemon-source-authority-scenarios.mjs";

registerScenarios(3, test);
