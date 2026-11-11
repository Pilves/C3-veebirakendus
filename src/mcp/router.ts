// The MCP endpoint (revision 2026-07-28, Streamable HTTP), mounted at /mcp by the server.
// This file is only the Express wiring: the rules live in protocol.ts, the tools in
// tools.ts. Every answer is one JSON object. The spec lets a server choose per request
// between JSON and an SSE stream (streamable-http: "either a single JSON object or a
// Server-Sent Events (SSE) stream"); nothing here takes long or sends progress, so this
// server never streams. There are no sessions: an Mcp-Session-Id header is ignored and
// never sent (streamable-http, Backward Compatibility: "ignore it, and do not mint or
// echo session IDs").
//
// THE ORDER OF THE CHECKS. The spec defines none, so it is fixed here, cheapest and most
// general first. Each step answers with the HTTP status and JSON-RPC code shown.
// (Before all of them the server refuses a foreign Host header for the whole app, with
// 403 and a plain JSON error: see server.ts.)
//    1. Origin present and not allowed                        403  -32600  (no id)
//    2. HTTP method is not POST                               405  -32600  (no id)
//    3. Content-Type is not application/json                  415  -32600  (no id)
//    4. Body too large / not valid JSON                       413  -32600 / 400 -32700
//    5. Not a single JSON-RPC 2.0 request or notification     400  -32600
//    6. A notification (no id): accepted, nothing to do       202  no body
//    7. MCP-Protocol-Version or Mcp-Method header missing     400  -32020
//    8. Protocol version is not 2026-07-28                    400  -32022
//    9. Headers disagree with the body                        400  -32020
//   10. _meta lacks protocol version or client capabilities   400  -32602
//   11. Unknown method                                        404  -32601
//   12. tools/call: Mcp-Name header, tool name, arguments     400  -32020 / -32602
//   13. Bad argument values, nothing found                    200  result with isError
// Steps 1-3 are checkBeforeBody, 4 is the body parser, 5-13 are handleMessage.
// From step 5 on, an error carries the request id whenever the body had a usable one.

import express, { Router } from "express";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import type { Store } from "../data/store.ts";
import type { Search } from "../search/search.ts";
import {
  ProtocolError,
  bodyParserError,
  checkBeforeBody,
  checkRequest,
  discoverResult,
  errorResponse,
  internalError,
  invalidParams,
  listToolsResult,
  methodNotFound,
  readMessage,
  readableId,
  resultResponse,
  toolArgumentsOf,
  toolNameOf,
} from "./protocol.ts";
import type { Headers, JsonObject, Message, RequestId } from "./protocol.ts";
import { createTools } from "./tools.ts";
import type { Tools } from "./tools.ts";

// The largest request body that is read. A real tools/call is a few hundred bytes; the
// limit stops a client from making the server buffer and parse megabytes.
const BODY_LIMIT = "100kb";

function sendError(response: Response, id: RequestId | undefined, error: ProtocolError): void {
  response.status(error.status).json(errorResponse(id, error));
}

// Anything that is not a ProtocolError is a bug in this server. The client gets a fixed
// message; the details, stack trace included, go to the server log only.
function asProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  console.error(error);
  return internalError();
}

// Step 12 and 13. tools, Error Handling: an "Unknown tool" is a protocol error, shown
// there with code -32602; on HTTP that is a 400.
function callTool(tools: Tools, headers: Headers, params: unknown): JsonObject {
  const name = toolNameOf(headers, params);
  const run = tools.find(name);
  if (run === undefined) throw invalidParams("unknown tool");
  return run(toolArgumentsOf(params));
}

// Step 11. The whole list of methods. Everything else is "Method not found", including
// `initialize` (removed in this revision), `ping`, and `subscriptions/listen` (this
// server announces no listChanged, so there is nothing to subscribe to).
function dispatch(tools: Tools, headers: Headers, message: Message): JsonObject {
  switch (message.method) {
    case "server/discover":
      return discoverResult();
    case "tools/list":
      return listToolsResult(tools.definitions);
    case "tools/call":
      return callTool(tools, headers, message.params);
    default:
      throw methodNotFound();
  }
}

// Mounted at /mcp by the server.
export function createMcpRouter(store: Store, search: Search): Router {
  const tools = createTools(store, search);
  const router = Router();

  // Steps 1-3, for every HTTP method, before any of the body is read.
  const checkHttp: RequestHandler = (request, response, next) => {
    try {
      checkBeforeBody(request.method, request.headers);
      next();
    } catch (error) {
      const failure = asProtocolError(error);
      if (failure.status === 405) response.set("Allow", "POST");
      sendError(response, undefined, failure);
    }
  };

  // Step 4. The parser exists only on this route. strict: false lets any JSON value
  // through (a bare string or number), so that step 5 can refuse it as "not a request"
  // rather than the parser calling valid JSON a parse error.
  const parseBody = express.json({ limit: BODY_LIMIT, strict: false });

  // Steps 5-13.
  const handleMessage: RequestHandler = (request, response) => {
    const body: unknown = request.body;
    try {
      const message = readMessage(body);
      // Step 6. streamable-http, Sending Messages: "If the server accepts it, the server
      // MUST return HTTP status code 202 Accepted with no body." This revision defines no
      // client notification over HTTP, so there is nothing to do with one. Its headers
      // are not checked: "header requirements for notification POSTs are not defined".
      if (message.id === undefined) {
        response.status(202).end();
        return;
      }
      checkRequest(request.headers, message);
      const result = dispatch(tools, request.headers, message);
      response.json(resultResponse(message.id, result));
    } catch (error) {
      sendError(response, readableId(body), asProtocolError(error));
    }
  };

  // Step 4, the failures: the body parser passes its errors here.
  // Four parameters mark this as an error handler for Express, so `next` stays.
  const handleBodyError: ErrorRequestHandler = (error, _request, response, _next) => {
    const failure = bodyParserError(error);
    if (failure.status === 500) console.error(error);
    sendError(response, undefined, failure);
  };

  // Only the exact path: /mcp/anything falls through to the server's JSON 404.
  router.all("/", checkHttp, parseBody, handleMessage);
  router.use(handleBodyError);
  return router;
}
