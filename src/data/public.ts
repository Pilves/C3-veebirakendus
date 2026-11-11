// The fields of a finding that leave the server, for the HTTP API and the MCP tools alike.
// One list in one place, so the two interfaces cannot drift apart.

import type { Finding } from "./normalise.ts";

// Every field is named, instead of copying the finding and deleting `raw`: a field
// added to Finding later stays private until someone adds it here on purpose.
export function publicFinding(finding: Finding) {
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
