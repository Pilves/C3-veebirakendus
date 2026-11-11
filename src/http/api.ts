// The JSON API under /api. It only checks the request, calls the store or the search, and
// shapes the answer; it holds no logic of its own about what matches.
// Two kinds of untrusted text pass through here. Request input (query string, path) is
// checked before use. Finding text (entity, notes) goes out exactly as stored, as JSON
// strings: escaping is the job of whoever renders it, and changing it here would alter
// evidence without making it safe.

import { Router } from "express";
import type { ErrorRequestHandler, Request } from "express";
import { ALL_TYPES, FLAGS } from "../data/normalise.ts";
import type { Finding, FindingType, Flag } from "../data/normalise.ts";
import { publicFinding } from "../data/public.ts";
import type { Store } from "../data/store.ts";
import { MAX_LIMIT } from "../search/search.ts";
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
  const type = ALL_TYPES.find((valid) => valid === value);
  if (type === undefined) {
    throw new BadRequest(`Parameter "type" must be one of: ${ALL_TYPES.join(", ")}`);
  }
  return type;
}

function flagParam(query: Query): Flag | undefined {
  const value = textParam(query, "flag");
  if (value === undefined) return undefined;
  const flag = FLAGS.find((valid) => valid === value);
  if (flag === undefined) {
    throw new BadRequest(`Parameter "flag" must be one of: ${FLAGS.join(", ")}`);
  }
  return flag;
}

function duplicatesParam(query: Query): boolean {
  const value = textParam(query, "duplicates");
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new BadRequest('Parameter "duplicates" must be 1, true, 0 or false');
}

// The same limit as the MCP tool's "query". The search does work for every word of the
// query on every finding, so its length is bounded here, at the edge.
const MAX_QUERY_LENGTH = 200;

// Counted in characters (code points), as the MCP tool's schema counts them: the spread
// walks the string by code point, so an emoji counts once.
function queryParam(query: Query): string | undefined {
  const value = textParam(query, "q");
  if (value !== undefined && [...value].length > MAX_QUERY_LENGTH) {
    throw new BadRequest(`Parameter "q" must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return value;
}

const LIMIT_RULE = `Parameter "limit" must be a whole number from 1 to ${MAX_LIMIT}`;
const OFFSET_RULE = 'Parameter "offset" must be a whole number, 0 or more';

// Digits only, so "1e3", "-1", "2.5" and "" are refused instead of being read as some
// number the caller did not mean. At most nine digits keeps the value an exact integer.
// `rule` is the message for a value that is not such a number.
function wholeNumberParam(query: Query, name: string, rule: string): number | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value)) throw new BadRequest(rule);
  return Number(value);
}

// A limit outside the range is refused, not quietly moved into it: the caller would get
// another page size than it asked for and never know. The MCP tool does the same.
function limitParam(query: Query): number | undefined {
  const limit = wholeNumberParam(query, "limit", LIMIT_RULE);
  if (limit !== undefined && (limit < 1 || limit > MAX_LIMIT)) throw new BadRequest(LIMIT_RULE);
  return limit;
}

// Parameters with other names are ignored. Bad input is refused here, not guessed at:
// the search trusts its callers to pass a bounded query and whole numbers.
function searchOptionsOf(request: Request): SearchOptions {
  const query: Query = request.query;
  return {
    query: queryParam(query),
    type: typeParam(query),
    caseId: textParam(query, "case"),
    flag: flagParam(query),
    includeDuplicates: duplicatesParam(query),
    limit: limitParam(query),
    offset: wholeNumberParam(query, "offset", OFFSET_RULE),
  };
}

// ---------- shaping the answers ----------

// The detail view also shows the record as it was originally recorded.
function detailedFinding(finding: Finding) {
  return { ...publicFinding(finding), raw: finding.raw };
}

// ---------- errors ----------

// The client only ever gets a fixed message or one written in this file: no stack trace
// and no internal error text. The unused `_next` has to stay: see handleError in app.ts.
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

  // No 404 here: any other path falls through to the server's JSON 404.
  router.use(handleError);
  return router;
}
