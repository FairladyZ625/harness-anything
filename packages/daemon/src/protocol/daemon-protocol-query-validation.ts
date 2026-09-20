import { validateRelationNeighborhoodPayload } from "./daemon-protocol-validate-relation-query.ts";
import { integer, nonEmpty, statusWord } from "./daemon-protocol-validate-entities.ts";
import { relationStateWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, isUtcTimestamp, unknownFieldViolation, type JsonObject } from "./json-rpc-types.ts";

// Absent facets keep the unparameterized full-result contract.
export function validateDaemonQueryPayload(
  method: "repo.tasks.list" | "repo.triadic.relationGraph",
  value: unknown,
): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return ["query payload must be an object"];
  if (method === "repo.triadic.relationGraph" && (value.entity !== undefined || value.hops !== undefined))
    return validateRelationNeighborhoodPayload(value);
  if (
    method === "repo.triadic.relationGraph" &&
    [value.facet, value.relationType, value.state, value.direction].some((field) => field !== undefined)
  )
    return validateRelationFacetPayload(value);
  const errors: string[] = [],
    status = value.status,
    changedAfterRevision = value.changedAfterRevision,
    after = value.updatedAfter,
    before = value.updatedBefore,
    limit = value.limit,
    cursor = value.cursor,
    stateError =
      status !== undefined && !statusWord(method === "repo.tasks.list" ? taskStatusWords : relationStateWords, status)
        ? `${method}.payload.status is invalid`
        : null;
  if (stateError) errors.push(stateError);
  if (
    method === "repo.tasks.list" &&
    changedAfterRevision !== undefined &&
    (!integer(changedAfterRevision) || Number(changedAfterRevision) < 0)
  )
    errors.push(`${method}.payload.changedAfterRevision is invalid`);
  if (
    [after, before].some((item) => item !== undefined && !isUtcTimestamp(item)) ||
    (typeof after === "string" && typeof before === "string" && after > before)
  )
    errors.push(`${method}.payload time window is invalid`);
  if (limit !== undefined && (!integer(limit) || Number(limit) < 1 || Number(limit) > 500))
    errors.push(`${method}.payload.limit is invalid`);
  if (cursor !== undefined && !nonEmpty(cursor)) errors.push(`${method}.payload.cursor is invalid`);
  return errors;
}

function validateRelationFacetPayload(value: JsonObject): string[] {
  const facet = value.facet,
    edgeFields = ["facet", "relationType", "state", "direction", "limit", "cursor"],
    allowed = facet === "edges" ? edgeFields : facet === "facts" ? ["facet", "limit", "cursor"] : ["facet"];
  if (!["edges", "facts", "coverageRows", "runtimeEdges"].includes(String(facet)))
    return ["repo.triadic.relationGraph.payload.facet is invalid"];
  const unknown = unknownFieldViolation(value, allowed);
  if (unknown) return [`repo.triadic.relationGraph.payload contains an ${unknown}`];
  const errors = validateDaemonQueryPayload("repo.triadic.relationGraph", {
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  });
  if (facet !== "edges") return errors;
  if (value.relationType !== undefined && !nonEmpty(value.relationType))
    errors.push("repo.triadic.relationGraph.payload.relationType is invalid");
  if (value.state !== undefined && !statusWord(relationStateWords, value.state))
    errors.push("repo.triadic.relationGraph.payload.state is invalid");
  if (value.direction !== undefined && !["directed", "undirected"].includes(String(value.direction)))
    errors.push("repo.triadic.relationGraph.payload.direction is invalid");
  return errors;
}
