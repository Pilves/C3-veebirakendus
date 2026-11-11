// The JSON API under /api. It only checks the request, calls the store or the search, and
// shapes the answer; it holds no logic of its own about what matches.
// Two kinds of untrusted text pass through here. Request input (query string, path) is
// checked before use. Finding text (entity, notes) goes out exactly as stored, as JSON
// strings: escaping is the job of whoever renders it, and changing it here would alter
// evidence without making it safe.

import { Router } from "express";
import type { ErrorRequestHandler, Request } from "express";
import { VALID_TYPES } from "../data/normalise.ts";
import type { Finding, FindingType } from "../data/normalise.ts";
import type { Store } from "../data/store.ts";
import type { Search, SearchOptions } from "../search/search.ts";

// Thrown by the checks below; the error handler turns it into HTTP 400. Its message is
// written here and never contains request text, so it is safe to send to the client.
class BadRequest extends Error {}

// ---------- reading the query string ----------

type Query = { [name: string]: unknown };

// A repeated parameter (?q=a&q=b) arrives as an array, and a bracketed one (?q[x]=1) as
// an object or under the name "q[x]", depending on Express's "query parser" setting.
// Both are refused rather than guessed at: there is no right way to pick one value.
function textParam(query: Query, name: string): string | undefined {
  const bracketed = Object.keys(query).some((key) => key.startsWith(`${name}[`));
  const value = query[name];
  if (bracketed || (value !== undefined && typeof value !== "string")) {
    throw new BadRequest(`Parameter "${name}" must be given once, as plain text`);
  }
  return value;
}

function typeParam(query: Query): FindingType | undefined {
  const value = textParam(query, "type");
  if (value === undefined) return undefined;
  if (value === "unknown") return value;
  const type = VALID_TYPES.find((valid) => valid === value);
  if (type === undefined) {
    throw new BadRequest(`Parameter "type" must be one of: ${VALID_TYPES.join(", ")}, unknown`);
  }
  return type;
}

function duplicatesParam(query: Query): boolean {
  const value = textParam(query, "duplicates");
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new BadRequest('Parameter "duplicates" must be 1, true, 0 or false');
}

// Digits only, so "1e3", "-1", "2.5" and "" are refused instead of being read as some
// number the caller did not mean. At most nine digits keeps the value an exact integer.
function wholeNumberParam(query: Query, name: string): number | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value)) {
    throw new BadRequest(`Parameter "${name}" must be a whole number, 0 or more`);
  }
  return Number(value);
}

// Parameters with other names are ignored. The search guards the query length and
// clamps limit and offset itself; the checks here make sure it gets the right types.
function searchOptionsOf(request: Request): SearchOptions {
  const query: Query = request.query;
  return {
    query: textParam(query, "q"),
    type: typeParam(query),
    caseId: textParam(query, "case"),
    includeDuplicates: duplicatesParam(query),
    limit: wholeNumberParam(query, "limit"),
    offset: wholeNumberParam(query, "offset"),
  };
}

// ---------- shaping the answers ----------

// Every field is named, instead of copying the finding and deleting `raw`: a field
// added to Finding later stays private until someone adds it here on purpose.
function publicFinding(finding: Finding) {
  return {
    key: finding.key,
    id: finding.id,
    entity: finding.entity,
    type: finding.type,
    caseIds: finding.caseIds,
    observedAt: finding.observedAt,
    sourceUrl: finding.sourceUrl,
    notes: finding.notes,
    duplicateOf: finding.duplicateOf,
    flags: finding.flags,
  };
}

// The detail view also shows the record as it was originally recorded.
function detailedFinding(finding: Finding) {
  return { ...publicFinding(finding), raw: finding.raw };
}

// ---------- errors ----------

// Four parameters mark this as an error handler for Express, so `next` stays even though
// it is unused. The client only ever gets a fixed message or one written in this file:
// no stack trace and no internal error text.
const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof BadRequest) {
    response.status(400).json({ error: error.message });
    return;
  }
  // Express throws URIError for a path it cannot decode, such as /api/findings/%E0%A4.
  if (error instanceof URIError) {
    response.status(400).json({ error: "Malformed URL" });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Internal error" });
};

// ---------- the router ----------

const ROUTES = ["/findings", "/findings/:id", "/cases"];

// Mounted at /api by the server. response.json sends application/json; charset=utf-8.
export function createApiRouter(store: Store, search: Search): Router {
  const router = Router();

  router.get("/findings", (request, response) => {
    const result = search(searchOptionsOf(request));
    const hits = result.hits.map((hit) => ({ ...hit, finding: publicFinding(hit.finding) }));
    response.json({ ...result, hits });
  });

  router.get("/findings/:id", (request, response) => {
    const findings = store.findById(request.params.id);
    if (findings.length === 0) {
      response.status(404).json({ error: "No finding with this id" });
      return;
    }
    // A list even for one record: an id shared by two records returns both.
    response.json({ findings: findings.map(detailedFinding) });
  });

  router.get("/cases", (_request, response) => {
    response.json(store.listCases());
  });

  // The API is read-only. Reached only when no GET route above answered.
  router.all(ROUTES, (_request, response) => {
    response.set("Allow", "GET, HEAD").status(405).json({ error: "Method not allowed" });
  });

  router.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  router.use(handleError);
  return router;
}
