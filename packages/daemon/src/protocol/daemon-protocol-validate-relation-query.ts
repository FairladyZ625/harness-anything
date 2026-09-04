import { statusWord, stringArray } from "./daemon-protocol-validate-entities.ts";
import { relationStateWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, unknownFieldViolation, type JsonObject } from "./json-rpc-types.ts";

export function validateRelationNeighborhoodPayload(value: JsonObject): string[] {
  const allowed = ["entity", "hops", "status"],
    unknown = unknownFieldViolation(value, allowed);
  if (unknown) return [`repo.triadic.relationGraph.payload contains an ${unknown}`];
  if (typeof value.entity !== "string" || value.entity.length === 0 || !isJsonObject(value.hops))
    return ["repo.triadic.relationGraph.payload requires entity and hops"];
  const hops = value.hops,
    hopsUnknown = unknownFieldViolation(hops, ["direction", "relationTypes", "maxDepth", "maxNodes"]);
  if (hopsUnknown) return [`repo.triadic.relationGraph.payload.hops contains an ${hopsUnknown}`];
  if (!["outgoing", "incoming", "both"].includes(String(hops.direction)))
    return ["repo.triadic.relationGraph.payload.hops.direction is invalid"];
  if (!stringArray(hops.relationTypes) || hops.relationTypes.length === 0)
    return ["repo.triadic.relationGraph.payload.hops.relationTypes is invalid"];
  if (!Number.isInteger(hops.maxDepth) || Number(hops.maxDepth) < 1 || Number(hops.maxDepth) > 4_096)
    return ["repo.triadic.relationGraph.payload.hops.maxDepth is invalid"];
  if (!Number.isInteger(hops.maxNodes) || Number(hops.maxNodes) < 1 || Number(hops.maxNodes) > 10_000)
    return ["repo.triadic.relationGraph.payload.hops.maxNodes is invalid"];
  const statusError =
    value.status !== undefined && !statusWord(relationStateWords, value.status)
      ? "repo.triadic.relationGraph.payload.status is invalid"
      : null;
  return statusError ? [statusError] : [];
}
