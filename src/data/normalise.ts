// Turns the raw findings into clean ones, once, at startup.
// Principle: normalise but never destroy. Each finding keeps its untouched raw record,
// gets cleaned fields beside it, and a list of flags naming every data-quality problem.
// The dataset is untrusted: values are only compared and copied, never interpreted or run.

export type ValidType = "domain" | "ip" | "email" | "handle" | "alias" | "wallet";
export type FindingType = ValidType | "unknown";

export const VALID_TYPES: ValidType[] = ["domain", "ip", "email", "handle", "alias", "wallet"];
// Every type a finding can end up with: what the type filters of the API and MCP offer.
export const ALL_TYPES: FindingType[] = [...VALID_TYPES, "unknown"];

// Every data-quality flag. The Flag type below is read off this list, so a flag cannot
// be added to one and forgotten in the other.
export const FLAGS = [
  "id-missing",
  "duplicate-id",
  "reimport",
  "entity-missing",
  "entity-whitespace",
  "type-nonstandard",
  "type-unknown",
  "type-mismatch",
  "case-missing",
  "case-nonstandard",
  "case-multiple",
  "time-invalid",
  "source-not-link",
  "notes-missing",
  "notes-markup",
  "notes-instructions",
] as const;

export type Flag = (typeof FLAGS)[number];

export type Finding = {
  key: string; // unique across the dataset
  id: string; // the id as given in the data, trimmed; "" when missing
  entity: string; // trimmed; letter case preserved for display
  type: FindingType; // one of the six valid types, or "unknown"
  caseIds: string[]; // always an array, possibly empty
  observedAt: string | null; // UTC ISO 8601, e.g. 2026-09-01T00:27:17.000Z
  sourceUrl: string | null; // set only if the raw value is an http: or https: URL
  notes: string | null; // exactly as written
  duplicateOf: string | null; // key of the original when this record is a re-import
  flags: Flag[];
  raw: unknown; // the untouched input record (unknown: it may not even be an object)
};

type RawFields = { [name: string]: unknown };

// A record that is not a plain object (null, a string, an array) is read as having no fields,
// so every rule below sees "missing" and flags it instead of throwing.
function fieldsOf(raw: unknown): RawFields {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as RawFields;
}

// ---------- id and key ----------

// Trimmed, because a lookup trims what the analyst typed: an id stored with a space
// around it could never be found. An id of only whitespace is no id at all.
function idOf(raw: unknown): string {
  const id = fieldsOf(raw).id;
  return typeof id === "string" ? id.trim() : "";
}

function countIds(rawRecords: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of rawRecords) {
    const id = idOf(raw);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// The ids that exactly one record has. Such a record's key is its id, always, so these
// are set aside before any key is made up for another record.
function uniqueIdsOf(idCounts: Map<string, number>): Set<string> {
  const unique = new Set<string>();
  for (const [id, count] of idCounts) {
    if (id !== "" && count === 1) unique.add(id);
  }
  return unique;
}

// Hands out the keys of one dataset and remembers them, so no key is ever given twice.
// A made-up key can look like a real id: ids "A", "A" and "A.1" would give "A.1" twice,
// and an id "row-2" would clash with a record without an id on row 2. A key that is
// taken is therefore stepped over: the suffix goes up until the key is free.
type KeyMaker = {
  numbered(base: string): string; // base.1, base.2, ...: the next one that is free
  forRow(row: number): string; // row-N, or row-N.1, ... when a record has that as its id
};

function createKeyMaker(taken: Set<string>): KeyMaker {
  // The last suffix used per base, so a thousand records sharing one id are numbered
  // by counting on, not by trying 1, 2, 3, ... from the start each time.
  const lastSuffix = new Map<string, number>();

  function numbered(base: string): string {
    let suffix = lastSuffix.get(base) ?? 0;
    let key: string;
    do {
      suffix++;
      key = `${base}.${suffix}`;
    } while (taken.has(key));
    lastSuffix.set(base, suffix);
    taken.add(key);
    return key;
  }

  function forRow(row: number): string {
    const key = `row-${row}`;
    if (taken.has(key)) return numbered(key);
    taken.add(key);
    return key;
  }

  return { numbered, forRow };
}

// ---------- entity ----------

function cleanEntity(raw: unknown, flags: Flag[]): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    flags.push("entity-missing");
    return "";
  }
  if (raw !== raw.trim()) flags.push("entity-whitespace");
  return raw.trim();
}

// ---------- type ----------

type Shape = "url" | "ipv4" | "ipv6" | "email" | "wallet" | "hostname" | "token" | "words";

const WALLET = /^(0x[0-9a-f]{40}|bc1[0-9a-z]{20,}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

// Deliberately simple checks, first match wins. They describe what an entity looks like;
// they do not validate it (999.1.1.1 still "looks like" an IPv4 address).
function shapeOf(entity: string): Shape {
  if (/^https?:\/\//i.test(entity)) return "url";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(entity)) return "ipv4";
  if (entity.includes(":") && /^[0-9a-f:]+$/i.test(entity)) return "ipv6";
  // The labels after the @ may not contain a dot themselves. That leaves only one way
  // to read any text, so the check stays fast on a long hostile entity; "[^@\s]+\."
  // could split a run of dots in many ways and took seconds on 40 kB.
  if (/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(entity)) return "email";
  if (WALLET.test(entity)) return "wallet";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(entity)) return "hostname";
  return /\s/.test(entity) ? "words" : "token";
}

// The shapes that do not contradict a label. handle and alias share one list on purpose:
// a nickname and an account name look the same, so shape cannot tell them apart.
const ALLOWED_SHAPES: { [type in ValidType]: Shape[] } = {
  domain: ["hostname"],
  ip: ["ipv4", "ipv6"],
  email: ["email"],
  wallet: ["wallet"],
  handle: ["token", "words"],
  alias: ["token", "words"],
};

// The label is never "corrected" from the entity: a wrong guess would hide the finding
// from an analyst filtering by type. A contradiction is only flagged.
function cleanType(raw: unknown, entity: string, flags: Flag[]): FindingType {
  const label = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const type = VALID_TYPES.find((valid) => valid === label);
  if (type === undefined) {
    flags.push("type-unknown");
    return "unknown";
  }
  if (raw !== type) flags.push("type-nonstandard");
  // An empty entity has no shape; it is already flagged as entity-missing.
  if (entity !== "" && !ALLOWED_SHAPES[type].includes(shapeOf(entity))) {
    flags.push("type-mismatch");
  }
  return type;
}

// ---------- caseIds ----------

function cleanCaseIds(raw: unknown, flags: Flag[]): string[] {
  const members = Array.isArray(raw) ? raw : [raw];
  const caseIds: string[] = [];
  let changed = false;
  for (const member of members) {
    const caseId = typeof member === "string" ? member.trim().toUpperCase() : "";
    if (caseId !== member) changed = true;
    // Empty and repeated members add nothing, and would make "case-multiple" lie.
    if (caseId !== "" && !caseIds.includes(caseId)) caseIds.push(caseId);
  }
  if (caseIds.length === 0) flags.push("case-missing");
  else if (changed) flags.push("case-nonstandard");
  if (caseIds.length > 1) flags.push("case-multiple");
  return caseIds;
}

// ---------- observedAt ----------

// Only ISO 8601 with an explicit zone. Date.parse alone also accepts "March 7" and reads
// a time without a zone as local time, which would differ from machine to machine.
// The groups are year, month, day and hour, for the check in isoEpochMs.
const ISO_WITH_ZONE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

// 1e11 ms is 1973 and 1e13 ms is 2286. A number outside that range is not a millisecond
// timestamp (it could be seconds), and guessing its unit would invent a wrong date.
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e13;

// True when the day exists in the calendar. Date.UTC rolls an impossible day over into
// the next month, so the three numbers are put in and read back: they survive only if
// the date is real.
function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Date.parse refuses month 13 or minute 60, but it rolls February 30 over to March 2
// and reads hour 24 as the next day. Such a time was never observed; keeping the
// rolled-over value would invent a date, so both are refused here first.
function isoEpochMs(text: string): number {
  const match = ISO_WITH_ZONE.exec(text);
  if (match === null) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  if (hour > 23 || !isCalendarDate(year, month, day)) return NaN;
  return Date.parse(text);
}

function epochMsOf(raw: unknown): number {
  if (typeof raw === "number") {
    const isMs = Number.isInteger(raw) && raw > MIN_EPOCH_MS && raw < MAX_EPOCH_MS;
    return isMs ? raw : NaN;
  }
  return typeof raw === "string" ? isoEpochMs(raw.trim()) : NaN;
}

function cleanObservedAt(raw: unknown, flags: Flag[]): string | null {
  const epochMs = epochMsOf(raw);
  if (Number.isNaN(epochMs)) {
    flags.push("time-invalid");
    return null;
  }
  return new Date(epochMs).toISOString();
}

// ---------- sourceUrl ----------

// The UI may render sourceUrl as a clickable link, so only http(s) passes: a javascript:
// or data: URL would run code in the analyst's browser. No scheme is guessed for
// "forum.example/thread/88", because the guess could point at the wrong place.
function cleanSourceUrl(raw: unknown, flags: Flag[]): string | null {
  if (typeof raw === "string" && isWebUrl(raw)) return raw;
  flags.push("source-not-link");
  return null;
}

// The text must itself begin with "http://" or "https://". new URL alone also accepts
// "http:/api/cases" and "http:evil.example" as http: URLs, and a browser then opens such
// a link RELATIVE to this tool's own address: it would not lead where it says.
function isWebUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const protocol = new URL(text).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// ---------- notes ----------

// Something shaped like an HTML tag: "<b>", "</script>", "<img src=x>". The length of a
// tag is bounded, so a long run of "<a<a<a" is still read in one pass.
// Exported, like INSTRUCTIONS below, so scripts/explore.ts counts with the same rule.
export const MARKUP = /<\/?[a-z][^<>]{0,500}>/i;

// Wording that addresses whoever reads the note instead of describing a finding. A list
// of keywords, not understanding: it can miss a reworded instruction and it can flag an
// honest note that says "ignore". The flag is a hint for the reader and never a filter,
// and the absence of the flag is not a promise that a note is harmless.
export const INSTRUCTIONS = new RegExp(
  [
    "\\bignore\\b",
    "\\bdisregard\\b",
    "^system:",
    "system prompt",
    "\\bassistant\\b",
    "\\bAI\\b",
    "\\binstructions?\\b",
    "reply (only )?with",
    "do not mention",
    "you (must|should)",
  ].join("|"),
  "i",
);

// Notes are kept byte-for-byte. Escaping is the job of whoever displays them; stripping
// tags here would destroy evidence and still not make the text safe to render. Suspect
// content is flagged, so the analyst and an MCP client see it named on the record.
function cleanNotes(raw: unknown, flags: Flag[]): string | null {
  if (typeof raw !== "string") {
    flags.push("notes-missing");
    return null;
  }
  if (MARKUP.test(raw)) flags.push("notes-markup");
  if (INSTRUCTIONS.test(raw)) flags.push("notes-instructions");
  return raw;
}

// ---------- re-imports ----------

// Two records with the same fingerprint describe the same finding. A record without an id,
// a time or an entity gets none: too little is known about it to call it a copy.
function fingerprintOf(finding: Finding): string | null {
  if (finding.id === "" || finding.entity === "" || finding.observedAt === null) return null;
  const parts = [finding.caseIds, finding.observedAt, finding.notes, finding.entity.toLowerCase()];
  // JSON keeps the parts apart, so no separator inside a value can fake a match.
  return JSON.stringify(parts);
}

// Shorter first, then as text, so "F-9" comes before "F-10". Compared as plain text,
// "F-10" would be the lower one, and the newer record would be called the original.
function isLowerId(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

function markReimports(findings: Finding[]): void {
  // The original of each fingerprint is the record with the lowest id.
  const originals = new Map<string, Finding>();
  for (const finding of findings) {
    const fingerprint = fingerprintOf(finding);
    if (fingerprint === null) continue;
    const original = originals.get(fingerprint);
    if (original === undefined || isLowerId(finding.id, original.id)) {
      originals.set(fingerprint, finding);
    }
  }
  for (const finding of findings) {
    const fingerprint = fingerprintOf(finding);
    if (fingerprint === null) continue;
    const original = originals.get(fingerprint);
    // Same id means the original itself, or a record that shares a duplicated id with it.
    // Neither is a re-import.
    if (original === undefined || original.id === finding.id) continue;
    finding.duplicateOf = original.key;
    finding.flags.push("reimport");
  }
}

// ---------- the normaliser ----------

// Takes the whole list because duplicate ids and re-imports only show across records.
// Never throws on a malformed record and never changes its input.
export function normaliseFindings(rawRecords: unknown[]): Finding[] {
  const idCounts = countIds(rawRecords);
  const keys = createKeyMaker(uniqueIdsOf(idCounts));
  const findings: Finding[] = [];

  for (let index = 0; index < rawRecords.length; index++) {
    const raw = rawRecords[index];
    const fields = fieldsOf(raw);
    const flags: Flag[] = [];

    const id = idOf(raw);
    let key = id;
    if (id === "") {
      // Without an id the position in the file is the only stable name the record has.
      key = keys.forRow(index + 1);
      flags.push("id-missing");
    } else if (idCounts.get(id) !== 1) {
      // Every sharer gets a suffix, so a lookup by the bare id can never silently pick one.
      key = keys.numbered(id);
      flags.push("duplicate-id");
    }

    const entity = cleanEntity(fields.entity, flags);
    findings.push({
      key,
      id,
      entity,
      type: cleanType(fields.type, entity, flags),
      caseIds: cleanCaseIds(fields.caseId, flags),
      observedAt: cleanObservedAt(fields.observedAt, flags),
      sourceUrl: cleanSourceUrl(fields.sourceUrl, flags),
      notes: cleanNotes(fields.notes, flags),
      duplicateOf: null,
      flags,
      raw,
    });
  }

  markReimports(findings);
  return findings;
}
