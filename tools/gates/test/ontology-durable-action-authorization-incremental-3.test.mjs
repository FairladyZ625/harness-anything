// harness-test-tier: contract
import test from "node:test";
import { registerScenarios } from "./ontology-durable-action-authorization-incremental-scenarios.mjs";

registerScenarios(3, test);
