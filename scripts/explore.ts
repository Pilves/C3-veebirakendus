// Data-quality report for data/findings.json. Read-only, prints plain text to stdout.
// Run from the repo root: node scripts/explore.ts
// The dataset is untrusted: every value is only counted or printed (truncated), never interpreted.
import { readFileSync } from "node:fs";

// Fields are `unknown` because the data is not uniform (null, arrays, numbers, missing keys).
type Raw = { [key: string]: unknown };
type DataFile = { _meta: { count: number }; findings: Raw[] };

const KEYS = ["id", "caseId", "entity", "type", "sourceUrl", "observedAt", "notes"];
const VALID_TYPES = ["domain", "ip", "email", "handle", "alias", "wallet"];

// Resolved against this file, so the script works from any cwd.
const dataPath = new URL("../data/findings.json", import.meta.url);
const data = JSON.parse(readFileSync(dataPath, "utf8")) as DataFile;
const findings = data.findings;

// ---------- printing helpers ----------

function out(line = "") {
  console.log(line);
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

// JSON.stringify makes whitespace, case and non-string values visible.
function show(v: unknown, max = 80): string {
  return cut(String(JSON.stringify(v)), max);
}

// The comparison form used throughout: trimmed and lowercased, "" for non-strings.
function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function ids(records: Raw[]): string {
  if (records.length > 40) return "(more than 40, not listed)";
  return records
    .map((f) => String(f.id))
    .sort()
    .join(" ");
}

// Groups records by a computed key and returns the groups sorted by key,
// so the report is the same on every run.
function groupBy(records: Raw[], keyOf: (f: Raw) => string): [string, Raw[]][] {
  const groups = new Map<string, Raw[]>();
  for (const f of records) {
    const key = keyOf(f);
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Prints one line per group: count, key and (for small groups) the ids.
function printGroups(records: Raw[], keyOf: (f: Raw) => string, listIds = true) {
  for (const [key, group] of groupBy(records, keyOf)) {
    const count = String(group.length).padStart(5);
    const idList = listIds && group.length <= 40 ? "   ids: " + ids(group) : "";
    out(`  ${count}  ${key}${idList}`);
  }
}

function printCount(label: string, records: Raw[]) {
  const idList = records.length > 0 ? "   ids: " + ids(records) : "";
  out(`  ${label}: ${records.length}${idList}`);
}

// ---------- timestamps ----------

// observedAt comes as ISO strings and as numbers; everything is reduced to epoch milliseconds.
function instant(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v);
  return NaN;
}

const ISO_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const ISO_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/;

function timeFormat(v: unknown): string {
  if (Number.isNaN(instant(v))) return "unparseable";
  if (typeof v === "number") {
    // 1e11 ms is 1973 and 1e13 ms is 2286: integers in between are taken to be milliseconds.
    const looksLikeMs = Number.isInteger(v) && v > 1e11 && v < 1e13;
    return looksLikeMs ? "epoch milliseconds (number)" : "other number";
  }
  const s = String(v);
  if (ISO_Z.test(s)) return "ISO with Z";
  if (ISO_OFFSET.test(s)) return "ISO with offset " + s.slice(-6);
  return "other parseable string";
}

// ---------- entity shapes ----------

const WALLET = /^(0x[0-9a-f]{40}|bc1[0-9a-z]{20,}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

// Deliberately simple shape checks, first match wins. They describe what an entity looks like.
function shape(entity: unknown): string {
  if (typeof entity !== "string") return "non-string";
  const e = entity.trim();
  if (e === "") return "empty";
  if (/^https?:\/\//i.test(e)) return "url";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(e)) return "ipv4";
  if (e.includes(":") && /^[0-9a-f:]+$/i.test(e)) return "ipv6";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "email";
  if (e.startsWith("@")) return "@handle";
  if (WALLET.test(e)) return "wallet";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(e)) return "hostname";
  return /\s/.test(e) ? "words" : "single token";
}

// Shapes that do not contradict a label. Anything else is reported as a contradiction.
const OK_SHAPES: { [type: string]: string[] } = {
  domain: ["hostname"],
  ip: ["ipv4", "ipv6"],
  email: ["email"],
  wallet: ["wallet"],
  handle: ["@handle", "single token"],
  alias: ["words", "single token"],
};

// ---------- URLs ----------

function scheme(v: unknown): string {
  if (v === undefined) return "missing";
  if (typeof v !== "string") return "non-string";
  if (v.trim() === "") return "empty";
  try {
    return new URL(v).protocol;
  } catch {
    return "unparseable";
  }
}

function withoutUtm(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_")) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return url;
  }
}

function noSlash(s: string): string {
  return s.replace(/\/$/, "");
}

// ---------- re-import detection ----------

// How two raw values of one field differ, for a pair already judged to be the same finding.
function difference(field: string, a: unknown, b: unknown): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return "identical";
  // The pair rule guarantees the same instant, so only the format can differ.
  if (field === "observedAt") return "timestamp format";
  if (typeof a !== "string" || typeof b !== "string") return "other";
  if (a.trim() === b.trim()) return "whitespace";
  if (a.toLowerCase() === b.toLowerCase()) return "letter case";
  if (norm(a) === norm(b)) return "whitespace + letter case";
  if (field !== "sourceUrl") return "other";
  if (noSlash(a) === noSlash(b)) return "URL trailing slash";
  if (withoutUtm(a) === withoutUtm(b)) return "URL utm params";
  if (noSlash(withoutUtm(a)) === noSlash(withoutUtm(b))) return "URL utm params + trailing slash";
  return "other";
}

// Every pair of records that share a key but not an id. Lower id first in each pair.
function pairsWithDifferentIds(keyOf: (f: Raw) => string): [Raw, Raw][] {
  const pairs: [Raw, Raw][] = [];
  const timed = findings.filter((f) => !Number.isNaN(instant(f.observedAt)));
  for (const [, group] of groupBy(timed, keyOf)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.id === b.id) continue;
        pairs.push(String(a.id) < String(b.id) ? [a, b] : [b, a]);
      }
    }
  }
  return pairs.sort(([, x], [, y]) => (String(x.id) < String(y.id) ? -1 : 1));
}

// ---------- the report ----------

out("== 1. Totals ==");
out(`  _meta.count: ${data._meta.count}   actual findings: ${findings.length}`);
const seenKeys = [...new Set(findings.flatMap((f) => Object.keys(f)))].sort();
out(`  keys seen: ${seenKeys.join(", ")}`);
for (const key of KEYS) {
  printCount(
    `records lacking "${key}"`,
    findings.filter((f) => !(key in f)),
  );
}

out("\n== 2. ids ==");
printCount("non-string ids", findings.filter((f) => typeof f.id !== "string"));
out("  formats (digits after the first replaced by x), with range:");
// "F-10578" becomes "F-1xxxx": keeps the prefix and first digit, masks the rest.
const idFormat = (f: Raw) => {
  const id = String(f.id);
  return id.slice(0, 3) + id.slice(3).replace(/\d/g, "x");
};
for (const [format, group] of groupBy(findings, idFormat)) {
  const sorted = group.map((f) => String(f.id)).sort();
  const count = String(group.length).padStart(5);
  out(`  ${count}  ${format}   ${sorted[0]} .. ${sorted[sorted.length - 1]}`);
}
const reused = groupBy(findings, (f) => String(f.id)).filter(([, group]) => group.length > 1);
out(`  ids used by more than one record: ${reused.length}`);
for (const [id, group] of reused) {
  out(`  ${id}`);
  for (const f of group) {
    out(`      entity=${show(f.entity)} type=${show(f.type)} caseId=${show(f.caseId)}`);
  }
}

out("\n== 3. Probable re-imports ==");
out("  Rule: different id, same raw caseId, same instant, same notes, entity equal after trim + lowercase.");
const strictKey = (f: Raw) =>
  [
    JSON.stringify(f.caseId),
    instant(f.observedAt),
    JSON.stringify(f.notes),
    norm(f.entity),
  ].join("|");
const pairs = pairsWithDifferentIds(strictKey);
// One row per pair, so the class summary below can reuse printGroups.
const pairClasses: Raw[] = [];
for (const [a, b] of pairs) {
  const diffs = ["entity", "type", "sourceUrl", "observedAt"]
    .map((field) => ({ field, kind: difference(field, a[field], b[field]) }))
    .filter((d) => d.kind !== "identical");
  const described =
    diffs.length === 0 ? "identical" : diffs.map((d) => `${d.field}: ${d.kind}`).join("; ");
  out(`  ${a.id} ~ ${b.id}: ${described}`);
  const kind =
    diffs.length === 0
      ? "identical"
      : diffs
          .map((d) => d.kind)
          .sort()
          .join(" + ");
  pairClasses.push({ id: b.id, kind });
}
out(`  pairs found: ${pairs.length}. Per class (a pair with several differences is one combined class):`);
printGroups(pairClasses, (p) => String(p.kind));
// Sanity check on the rule: a much looser key shows whether the strict one misses near-duplicates.
const loosePairs = pairsWithDifferentIds((f) => instant(f.observedAt) + "|" + norm(f.entity));
const strictIds = new Set(pairs.map(([a, b]) => `${a.id} ${b.id}`));
const missed = loosePairs.filter(([a, b]) => !strictIds.has(`${a.id} ${b.id}`));
out(
  `  Looser rule (same instant + normalised entity only): ${loosePairs.length} pairs, ` +
    `${missed.length} not found by the strict rule.`,
);
for (const [a, b] of missed) {
  out(
    `      ${a.id} ~ ${b.id}: caseId ${show(a.caseId)} vs ${show(b.caseId)}; ` +
      `notes equal: ${a.notes === b.notes}`,
  );
}

out("\n== 4. type ==");
out("  raw values:");
printGroups(findings, (f) => show(f.type), false);
const offSpecRaw = findings.filter(
  (f) => typeof f.type !== "string" || !VALID_TYPES.includes(f.type),
);
printGroups(offSpecRaw, (f) => "off-spec " + show(f.type));
// "labelled": the type is one of the six valid ones once trimmed and lowercased.
const labelled = findings.filter((f) => VALID_TYPES.includes(norm(f.type)));
out(`  entity shape per normalised valid type (${labelled.length} records):`);
printGroups(labelled, (f) => `${norm(f.type)} -> ${shape(f.entity)}`, false);
const contradicting = labelled.filter(
  (f) => !OK_SHAPES[norm(f.type)]!.includes(shape(f.entity)),
);
out(`  entity shape contradicts the label: ${contradicting.length}`);
for (const f of contradicting) {
  out(
    `      ${f.id}  type=${show(f.type)}  entity=${show(f.entity)}  ` +
      `(looks like ${shape(f.entity)})`,
  );
}
out("  entity shape under labels that are off-spec even after trim + lowercase:");
const neverValid = findings.filter((f) => !VALID_TYPES.includes(norm(f.type)));
printGroups(neverValid, (f) => `${show(f.type)} -> ${shape(f.entity)}`);

out("\n== 5. caseId ==");
function caseKind(f: Raw): string {
  if (!("caseId" in f)) return "missing";
  if (f.caseId === null) return "null";
  if (Array.isArray(f.caseId)) return "array";
  if (typeof f.caseId === "string") return "string";
  return "other";
}
printGroups(findings, caseKind);
const caseNorm = (v: unknown) => String(v).trim().toUpperCase();
const stringCases = findings.filter((f) => typeof f.caseId === "string");
printCount(
  "strings that change under trim + uppercase",
  stringCases.filter((f) => f.caseId !== caseNorm(f.caseId)),
);
printCount(
  "strings not shaped like C-nnn after normalisation",
  stringCases.filter((f) => !/^C-\d+$/.test(caseNorm(f.caseId))),
);
const distinctCases = new Set(stringCases.map((f) => caseNorm(f.caseId)));
const distinctRawCases = new Set(stringCases.map((f) => f.caseId));
out(`  distinct cases (strings only, normalised): ${distinctCases.size}`);
out(`  distinct raw string values: ${distinctRawCases.size}`);
const oddCases = findings.filter(
  (f) => caseKind(f) !== "string" || f.caseId !== caseNorm(f.caseId),
);
for (const f of oddCases) {
  out(`      ${f.id}  caseId=${show(f.caseId)}`);
}

out("\n== 6. observedAt ==");
printGroups(findings, (f) => timeFormat(f.observedAt), false);
const instants = findings
  .map((f) => instant(f.observedAt))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b);
const earliest = new Date(instants[0]!).toISOString();
const latest = new Date(instants[instants.length - 1]!).toISOString();
out(`  earliest: ${earliest}   latest: ${latest}`);

out("\n== 7. sourceUrl ==");
printGroups(findings, (f) => scheme(f.sourceUrl), false);
const notWeb = findings.filter((f) => !["http:", "https:"].includes(scheme(f.sourceUrl)));
out(`  not http/https: ${notWeb.length}`);
for (const f of notWeb) {
  out(`      ${f.id}  ${scheme(f.sourceUrl)}  ${show(f.sourceUrl)}`);
}
const webUrls = findings.filter((f) => !notWeb.includes(f));
printCount(
  "http/https with surrounding whitespace",
  webUrls.filter((f) => f.sourceUrl !== String(f.sourceUrl).trim()),
);
printCount(
  "http/https with utm_ parameters",
  webUrls.filter((f) => String(f.sourceUrl).includes("utm_")),
);

out("\n== 8. notes ==");
const note = (f: Raw) => String(f.notes);
const isText = (f: Raw) => typeof f.notes === "string" && f.notes.trim() !== "";
printCount("missing", findings.filter((f) => !("notes" in f)));
printCount("null", findings.filter((f) => f.notes === null));
printCount(
  "empty or whitespace-only string",
  findings.filter((f) => typeof f.notes === "string" && f.notes.trim() === ""),
);
printCount(
  "other non-string",
  findings.filter((f) => "notes" in f && f.notes !== null && typeof f.notes !== "string"),
);
const texts = findings.filter(isText);
const HTML_TAG = /<\/?[a-z][^>]*>/i;
const HTML_ENTITY = /&(#\d+|#x[0-9a-f]+|[a-z]+);/i;
printCount("contain something like an HTML tag", texts.filter((f) => HTML_TAG.test(note(f))));
printCount(
  "contain an HTML entity (&lt; &#60; ...)",
  texts.filter((f) => HTML_ENTITY.test(note(f))),
);
for (const f of texts.filter((f) => HTML_TAG.test(note(f)) || HTML_ENTITY.test(note(f)))) {
  out(`      ${f.id}  ${show(f.notes)}`);
}
// Keyword heuristic only: it flags wording that addresses a reader/assistant
// instead of describing a finding.
const INJECTION = new RegExp(
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
const injections = texts.filter((f) => INJECTION.test(note(f)));
out(`  look like instructions to an AI assistant (keyword heuristic): ${injections.length}`);
for (const f of injections) {
  out(`      ${f.id}  ${show(f.notes, 60)}`);
}
// Heuristic: a common English word => English; otherwise an Estonian letter or common word => Estonian.
// English is tested first because English notes quote Estonian names (e.g. aliases with õ/ö).
// "on" is left out of the English list because it is also the Estonian word for "is".
const EN = /\b(the|an|and|is|was|of|to|in|for|from|by|with|every|this)\b/i;
const ET = /[õäöüšž]|\b(ja|on|ei|see|kui|ning|enne|vajab)\b/i;
function language(f: Raw): string {
  if (EN.test(note(f))) return "English";
  if (ET.test(note(f))) return "Estonian";
  return "undetermined";
}
out("  language split of non-empty notes (word-list heuristic, not real language detection):");
printGroups(texts, language, false);
out("  undetermined texts:");
const undetermined = texts.filter((f) => language(f) === "undetermined");
printGroups(undetermined, (f) => show(f.notes, 60), false);
const distinctNotes = new Set(texts.map(note));
out(`  distinct note texts: ${distinctNotes.size} across ${texts.length} non-empty notes`);

out("\n== 9. entity ==");
const isString = (f: Raw) => typeof f.entity === "string";
printCount("missing or non-string", findings.filter((f) => !isString(f)));
printCount(
  "empty or whitespace-only",
  findings.filter((f) => typeof f.entity === "string" && f.entity.trim() === ""),
);
const padded = findings.filter((f) => typeof f.entity === "string" && f.entity !== f.entity.trim());
printCount("leading/trailing whitespace", padded);
for (const f of padded) {
  out(`      ${f.id}  ${show(f.entity)}`);
}
const rawEntities = new Set(findings.map((f) => f.entity));
const upper = findings.filter(
  (f) => typeof f.entity === "string" && f.entity !== f.entity.toLowerCase(),
);
printCount("contain uppercase letters", upper);
// An uppercase entity whose lowercase form is another record's entity is a likely case-only duplicate.
const upperTwin = upper.filter((f) => rawEntities.has(norm(f.entity)));
printCount(
  "contain uppercase AND the trimmed lowercase form exists as another record's entity",
  upperTwin,
);
for (const f of upperTwin) {
  out(`      ${f.id}  ${show(f.entity)}`);
}
const distinctNorm = new Set(findings.map((f) => norm(f.entity)));
out(`  distinct entities: ${rawEntities.size} raw, ${distinctNorm.size} after trim + lowercase`);
