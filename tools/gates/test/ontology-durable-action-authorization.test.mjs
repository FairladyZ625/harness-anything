// harness-test-tier: contract
import test from "node:test";
import { registerScenarios } from "./ontology-durable-action-authorization-scenarios.mjs";

registerScenarios(1, test);
