// The browser UI: search box, filters, result list and detail panel. An ES module, so the
// code runs in strict mode, after the page is parsed, and adds no global names.
//
// SECURITY: every finding text that comes from the API (entity, notes, source, the raw
// record) is untrusted. Some notes contain HTML and script on purpose. This file never
// turns a string into markup: every node is made with document.createElement and every
// text is set through textContent or createTextNode, so the browser shows such notes as
// the characters they are. Styling is done with class names only.

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 250;
// Longest text accepted from the page address. The server has its own limits; this one
// only keeps an absurd address from being copied into the controls.
const MAX_URL_TEXT = 300;

function byId(id) {
  return document.getElementById(id);
}

const el = {
  query: byId("query"),
  type: byId("type"),
  caseId: byId("case"),
  duplicates: byId("duplicates"),
  caseError: byId("case-error"),
  summary: byId("summary"),
  searchError: byId("search-error"),
  searchErrorText: byId("search-error-text"),
  retry: byId("retry"),
  empty: byId("empty"),
  openAsId: byId("open-as-id"),
  hits: byId("hits"),
  pager: byId("pager"),
  previous: byId("previous"),
  next: byId("next"),
  range: byId("range"),
  zoneNote: byId("zone-note"),
  detail: byId("detail"),
  detailHeading: byId("detail-heading"),
  closeDetail: byId("close-detail"),
  detailBody: byId("detail-body"),
};

// Everything the view depends on. The page address is a copy of this (see writeUrl), so
// a search can be bookmarked and the back button works.
const state = {
  query: "",
  type: "", // "" means all types
  caseId: "", // "" means all cases
  duplicates: false,
  page: 1,
  selected: "", // key or id of the finding in the detail panel, "" when none
};

let debounceTimer = 0;
let searchAbort = null; // AbortController of the search request in flight
let detailAbort = null; // the same for the detail request
let lastPage = 1;
// The <li> of every result on the page, by finding key. A Map, because keys come from the
// data and a name like "__proto__" must not find anything on a plain object.
const rowsByKey = new Map();

// ---------- small DOM helpers ----------

// `tag` and `className` are always fixed words written in this file, never data.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// For entity and notes. The page says lang="en", but this text may be Estonian or
// anything else. An empty lang tells a screen reader "language unknown", and
// translate="no" keeps a browser translator from rewriting evidence.
function markAsEvidence(node) {
  node.setAttribute("lang", "");
  node.setAttribute("translate", "no");
  return node;
}

function optionNode(label, value) {
  const node = element("option", undefined, label);
  node.value = value;
  return node;
}

function hasOption(select, value) {
  return [...select.options].some((option) => option.value === value);
}

// ---------- highlighting ----------

// Walks the ranges from the server and cuts the ORIGINAL string into plain text nodes
// and <mark> elements. The pieces are only ever text, so a note that contains "<script>"
// stays those eight characters.
function highlighted(text, ranges) {
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const range of ranges) {
    // The server promises sorted, non-overlapping ranges inside the string. A range that
    // breaks the promise is skipped, so the text is still shown once and in full.
    if (!isUsableRange(range, position, text.length)) continue;
    fragment.append(document.createTextNode(text.slice(position, range.start)));
    fragment.append(element("mark", undefined, text.slice(range.start, range.end)));
    position = range.end;
  }
  fragment.append(document.createTextNode(text.slice(position)));
  return fragment;
}

function isUsableRange(range, position, length) {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return false;
  return range.start >= position && range.end > range.start && range.end <= length;
}

// ---------- times ----------

function twoDigits(number) {
  return String(number).padStart(2, "0");
}

// Local time as 2026-10-27 13:58. Built by hand because toLocaleString gives a different
// order of day and month on different machines. Empty when there is no valid time.
function localTime(iso) {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  const time = [date.getHours(), date.getMinutes()];
  return `${day.map(twoDigits).join("-")} ${time.map(twoDigits).join(":")}`;
}

function timeZoneName() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ---------- data-quality flags ----------

// Flag name from the server -> [short label for the list, one sentence for the detail].
const FLAG_TEXTS = new Map([
  ["id-missing", ["no id", "The record has no id; its key is its row number in the file."]],
  ["duplicate-id", ["duplicate id",
    "Another, unrelated record has the same id; the key adds a number to tell them apart."]],
  ["reimport", ["re-import", "This record is a copy of an earlier record, imported again."]],
  ["entity-missing", ["no entity", "The record has no entity text."]],
  ["entity-whitespace", ["entity trimmed",
    "The entity had spaces around it; they were removed for display and search."]],
  ["type-nonstandard", ["type respelled",
    "The type was written in another letter case or with spaces; it was read as a known type."]],
  ["type-unknown", ["unknown type",
    "The recorded type is missing or is not one of the six known types."]],
  ["type-mismatch", ["type does not match entity",
    "The entity does not look like its type says; the type was left as recorded."]],
  ["case-missing", ["no case", "The record names no case."]],
  ["case-nonstandard", ["case id respelled",
    "The case id was written in another letter case or with spaces and was tidied."]],
  ["case-multiple", ["several cases",
    "The record belongs to more than one case and is counted in each of them."]],
  ["time-invalid", ["no valid time",
    "The observed time is missing or is not in a format that can be read without guessing."]],
  ["source-not-link", ["no source link",
    "The source is missing or is not an http(s) address; it is shown as text, not as a link."]],
  ["notes-missing", ["no notes", "The record has no notes."]],
]);

// A flag this file does not know yet is shown by its name instead of being dropped.
function flagLabel(flag) {
  return FLAG_TEXTS.get(flag)?.[0] ?? String(flag);
}

function flagExplanation(flag) {
  return FLAG_TEXTS.get(flag)?.[1] ?? "No explanation is available for this flag.";
}

// ---------- the page address ----------

function shortText(value) {
  return (value ?? "").slice(0, MAX_URL_TEXT);
}

// "2" -> 2. Anything else ("-5", "1e3", "abc", "0", nothing) -> 1.
function pageNumberOf(value) {
  if (value === null || !/^\d{1,6}$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

// The address is typed, pasted and edited by people, so each value is checked before it
// becomes state. Unknown values fall back to the default instead of raising an error.
function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const type = params.get("type") ?? "";
  state.query = shortText(params.get("q"));
  state.type = hasOption(el.type, type) ? type : "";
  // The server compares case ids trimmed and in upper case; doing the same here lets
  // "case-1" in an address select the option "CASE-1".
  state.caseId = shortText(params.get("case")).trim().toUpperCase();
  state.duplicates = params.get("duplicates") === "1";
  state.page = pageNumberOf(params.get("page"));
  state.selected = shortText(params.get("selected")).trim();
}

// Only what differs from the default is written, so the plain view has a plain address.
function pageAddress() {
  const params = new URLSearchParams();
  if (state.query !== "") params.set("q", state.query);
  if (state.type !== "") params.set("type", state.type);
  if (state.caseId !== "") params.set("case", state.caseId);
  if (state.duplicates) params.set("duplicates", "1");
  if (state.page > 1) params.set("page", String(state.page));
  if (state.selected !== "") params.set("selected", state.selected);
  const search = params.toString();
  return search === "" ? location.pathname : `${location.pathname}?${search}`;
}

// push = true adds a step the back button returns to (filter, page, open a finding).
// push = false replaces the current step (typing), so "back" does not undo letter by letter.
function writeUrl(push) {
  const address = pageAddress();
  if (address === location.pathname + location.search) return;
  if (push) history.pushState(null, "", address);
  else history.replaceState(null, "", address);
}

function syncControls() {
  el.query.value = state.query;
  el.type.value = state.type;
  el.duplicates.checked = state.duplicates;
  showCaseInSelect();
}

// A case from the address that is not in the list still gets an option, so the select
// never shows "All cases" while a case filter is in fact applied.
function showCaseInSelect() {
  if (!hasOption(el.caseId, state.caseId)) {
    el.caseId.append(optionNode(`${state.caseId} (not in the case list)`, state.caseId));
  }
  el.caseId.value = state.caseId;
}

// ---------- talking to the API ----------

// Returns the parsed JSON, or throws an Error whose message can be shown to the analyst.
// Only same-origin paths starting with /api/ are ever passed in.
async function fetchJson(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch {
    // fetch rejects when no answer arrived at all (server down, no network, cancelled).
    throw new Error("Cannot reach the server. Check that it is running, then try again.");
  }
  // An error page from a proxy may not be JSON; then only the status is known.
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : "no message";
    throw new Error(`The server refused the request (${response.status}): ${message}`);
  }
  if (body === null) throw new Error("The server sent an answer that is not JSON.");
  return body;
}

// The API answers 400 to an empty type= or duplicates=, so unset filters are left out.
function searchPath() {
  const params = new URLSearchParams();
  if (state.query.trim() !== "") params.set("q", state.query);
  if (state.type !== "") params.set("type", state.type);
  if (state.caseId !== "") params.set("case", state.caseId);
  if (state.duplicates) params.set("duplicates", "1");
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String((state.page - 1) * PAGE_SIZE));
  return `/api/findings?${params}`;
}

// ---------- search ----------

async function runSearch() {
  // Cancel the request this one overtakes. Without it a slow answer to "abc" could
  // arrive after the answer to "abcd" and replace the newer results.
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  el.summary.textContent = "Searching…";
  try {
    const result = await fetchJson(searchPath(), controller.signal);
    if (controller.signal.aborted) return;
    if (!Array.isArray(result.hits) || !Number.isInteger(result.total)) {
      throw new Error("The server sent an answer in an unexpected shape.");
    }
    showResults(result);
  } catch (error) {
    // A cancelled request also lands here; a newer one is in charge of the screen then.
    if (controller.signal.aborted) return;
    showSearchError(error.message);
  }
}

function showResults(result) {
  lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  // An address can ask for page 99 of 3. Show the last real page instead of an empty one.
  if (result.hits.length === 0 && result.total > 0 && state.page > lastPage) {
    state.page = lastPage;
    writeUrl(false);
    runSearch();
    return;
  }
  rowsByKey.clear();
  el.hits.replaceChildren(...result.hits.map(hitRow));
  el.searchError.hidden = true;
  el.summary.textContent = summaryText(result.total);
  showEmptyState(result.total === 0);
  showPager(result);
  markSelectedRow();
}

function summaryText(total) {
  if (total === 0) return "0 findings";
  return total === 1 ? "1 finding" : `${total} findings`;
}

function showSearchError(message) {
  rowsByKey.clear();
  el.hits.replaceChildren();
  el.pager.hidden = true;
  el.empty.hidden = true;
  el.summary.textContent = "The search failed.";
  el.searchErrorText.textContent = message;
  el.searchError.hidden = false;
}

// The search looks in entity and notes only, not in ids. When nothing matched and the
// query is one word, it may be an id the analyst pasted, so offer to open it as one.
function showEmptyState(isEmpty) {
  const word = state.query.trim();
  el.empty.hidden = !isEmpty;
  el.openAsId.hidden = word === "" || /\s/.test(word);
  el.openAsId.textContent = `Open the finding with id "${word}"`;
}

function showPager(result) {
  const first = result.offset + 1;
  const last = result.offset + result.hits.length;
  el.pager.hidden = result.total === 0;
  el.range.textContent = `${first}–${last} of ${result.total}`;
  el.previous.disabled = state.page <= 1;
  el.next.disabled = state.page >= lastPage;
}

// ---------- one row of the result list ----------

function hitRow(hit) {
  const finding = hit.finding;
  const row = element("li");
  const head = element("div", "hit-head");
  head.append(entityButton(finding, hit.entityRanges), hitMeta(finding));
  row.append(head);
  if (finding.notes !== null) {
    const notes = markAsEvidence(element("p", "hit-notes"));
    notes.append(highlighted(finding.notes, hit.notesRanges));
    row.append(notes);
  }
  if (finding.flags.length > 0) row.append(badgeList(finding.flags));
  rowsByKey.set(finding.key, row);
  return row;
}

function entityButton(finding, ranges) {
  const open = button("entity", undefined, () => selectFinding(finding.key));
  if (finding.entity === "") open.textContent = "(no entity)";
  else markAsEvidence(open).append(highlighted(finding.entity, ranges));
  return open;
}

function hitMeta(finding) {
  const meta = element("span", "hit-meta");
  const cases = finding.caseIds.length > 0 ? finding.caseIds.join(", ") : "no case";
  const time = localTime(finding.observedAt) || "no valid time";
  meta.append(element("span", "type", finding.type), ` ${cases} · ${time}`);
  return meta;
}

function badgeList(flags) {
  const list = element("ul", "badges");
  list.setAttribute("aria-label", "Data-quality notes");
  for (const flag of flags) list.append(element("li", undefined, flagLabel(flag)));
  return list;
}

function markSelectedRow() {
  for (const [key, row] of rowsByKey) {
    const isSelected = key === state.selected;
    row.classList.toggle("selected", isSelected);
    const open = row.querySelector("button.entity");
    if (isSelected) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
  }
}

// ---------- detail panel ----------

async function loadDetail() {
  detailAbort?.abort();
  const isOpen = state.selected !== "";
  // On a narrow screen this class makes the panel take over the view (see styles.css).
  document.body.classList.toggle("detail-open", isOpen);
  el.closeDetail.hidden = !isOpen;
  markSelectedRow();
  if (!isOpen) {
    showDetailMessage("muted", "Select a finding to see its details.");
    return;
  }
  const controller = new AbortController();
  detailAbort = controller;
  showDetailMessage("muted", "Loading…");
  try {
    // encodeURIComponent keeps a key with "/" or "?" in it inside one path segment.
    const path = `/api/findings/${encodeURIComponent(state.selected)}`;
    const body = await fetchJson(path, controller.signal);
    if (controller.signal.aborted) return;
    if (!Array.isArray(body.findings)) {
      throw new Error("The server sent an answer in an unexpected shape.");
    }
    showDetail(body.findings);
  } catch (error) {
    if (controller.signal.aborted) return;
    showDetailMessage("error", error.message);
  }
}

function showDetailMessage(className, text) {
  el.detailBody.replaceChildren(element("p", className, text));
}

// The API returns a list: an id shared by unrelated records returns all of them.
function showDetail(findings) {
  const nodes = [];
  if (findings.length > 1) {
    const note = `${findings.length} unrelated records share this id. All are shown below.`;
    nodes.push(element("p", "notice shared-id-note", note));
  }
  findings.forEach((finding, index) => {
    nodes.push(recordView(finding, index + 1, findings.length));
  });
  el.detailBody.replaceChildren(...nodes);
}

function recordView(finding, position, count) {
  const record = element("article", "record");
  if (count > 1) record.append(element("p", "muted", `Record ${position} of ${count}`));
  const entity = finding.entity === "" ? "(no entity)" : finding.entity;
  record.append(markAsEvidence(element("h3", undefined, entity)));
  record.append(fieldList(finding));
  record.append(...recordLinks(finding));
  record.append(element("h4", undefined, "Data-quality flags"), flagList(finding.flags));
  record.append(element("h4", undefined, "Record as originally recorded"));
  // JSON.stringify gives undefined for a few values (a bare undefined); show that word.
  const rawText = JSON.stringify(finding.raw, null, 2) ?? "undefined";
  record.append(markAsEvidence(element("pre", undefined, rawText)));
  return record;
}

function fieldList(finding) {
  const list = element("dl");
  addField(list, "Type", typeValue(finding));
  addField(list, "Id", finding.id === "" ? "(none)" : finding.id);
  addField(list, "Key", finding.key);
  addField(list, "Cases", finding.caseIds.length > 0 ? finding.caseIds.join(", ") : "(none)");
  addField(list, "Observed", observedValue(finding));
  addField(list, "Source", sourceValue(finding));
  const notes = finding.notes === null ? "(none)" : markAsEvidence(notesValue(finding.notes));
  addField(list, "Notes", notes);
  return list;
}

// `content` is a string (set as text) or a node built by this file.
function addField(list, label, content) {
  const value = element("dd");
  value.append(content);
  list.append(element("dt", undefined, label), value);
}

function notesValue(notes) {
  return element("span", undefined, notes);
}

// One field of the raw record, or undefined. The raw record is whatever was in the input
// file: it may not be an object at all, and only its own fields are read.
function rawField(raw, name) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.hasOwn(raw, name) ? raw[name] : undefined;
}

// A recorded value as inert text in a bordered box.
function rawValueNode(value) {
  let text = JSON.stringify(value);
  if (value === undefined) text = "(missing)";
  else if (value === "") text = "(empty text)";
  else if (typeof value === "string") text = value;
  return markAsEvidence(element("code", "raw-value", text));
}

function typeValue(finding) {
  const value = element("span", undefined, finding.type);
  const differed = finding.flags.includes("type-nonstandard")
    || finding.flags.includes("type-unknown");
  if (differed) value.append(" — recorded as ", rawValueNode(rawField(finding.raw, "type")));
  return value;
}

function observedValue(finding) {
  const value = element("span");
  if (finding.observedAt === null) {
    const recorded = rawValueNode(rawField(finding.raw, "observedAt"));
    value.append("No valid time. Recorded value: ", recorded);
    return value;
  }
  const local = `${localTime(finding.observedAt)} local time (${timeZoneName()})`;
  value.append(`${local}\n${finding.observedAt} (UTC)`);
  return value;
}

// ---------- the source link ----------

// The server already sets sourceUrl only for http(s) addresses. This checks again here,
// right where the link is made: a javascript: or data: address in an href would run code
// when clicked, so a second, independent check is worth four lines.
function isWebUrl(text) {
  // "http:/x" and "http:x" also parse as http:, but a browser opens them relative to
  // this page's own address, so the text must itself start with the full scheme.
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const protocol = new URL(text).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function sourceValue(finding) {
  if (typeof finding.sourceUrl === "string" && isWebUrl(finding.sourceUrl)) {
    return sourceLink(finding.sourceUrl);
  }
  const recorded = rawField(finding.raw, "sourceUrl");
  const value = element("span");
  value.append(`Not a link: ${whyNotLink(recorded)}. Recorded value: `, rawValueNode(recorded));
  return value;
}

function sourceLink(url) {
  // The whole address is the link text, so the analyst sees where it leads before clicking.
  const link = markAsEvidence(element("a", undefined, url));
  // The parsed form, so the browser opens exactly the address that was checked.
  link.href = new URL(url).href;
  // A new tab, and the opened site gets neither a handle on this page nor its address.
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function whyNotLink(recorded) {
  if (recorded === undefined || recorded === null) return "no source was recorded";
  if (typeof recorded !== "string") return "the recorded value is not text";
  if (recorded.trim() === "") return "the recorded value is empty";
  if (!URL.canParse(recorded)) return "it is not a full web address (no http:// or https://)";
  return "its scheme is not http or https, so opening it could run code";
}

// ---------- flags and links to other records ----------

function flagList(flags) {
  if (flags.length === 0) return element("p", "muted", "None.");
  const list = element("ul");
  for (const flag of flags) {
    const item = element("li");
    item.append(element("strong", undefined, flagLabel(flag)), ` — ${flagExplanation(flag)}`);
    list.append(item);
  }
  return list;
}

function recordLinks(finding) {
  const links = [];
  if (finding.duplicateOf !== null) {
    const text = `Open the original record (${finding.duplicateOf})`;
    links.push(linkParagraph(text, finding.duplicateOf));
  }
  // The key of such a record is the id plus a number, so the id finds all its sharers.
  const sharesId = finding.id !== "" && finding.id !== finding.key;
  if (sharesId && state.selected !== finding.id) {
    links.push(linkParagraph(`Show all records with id ${finding.id}`, finding.id));
  }
  return links;
}

function linkParagraph(text, keyOrId) {
  const paragraph = element("p");
  paragraph.append(button(undefined, text, () => selectFinding(keyOrId)));
  return paragraph;
}

// ---------- actions ----------

function selectFinding(keyOrId) {
  state.selected = keyOrId;
  writeUrl(true);
  loadDetail();
  // Keyboard and screen-reader users land in the panel they just opened.
  el.detailHeading.focus();
}

function closeDetail() {
  const row = rowsByKey.get(state.selected);
  state.selected = "";
  writeUrl(true);
  loadDetail();
  // Back to where the analyst was in the list, or to the search box if that row is gone.
  const target = row?.querySelector("button.entity") ?? el.query;
  target.focus();
}

// Copies the controls into the state and searches from the first page.
function searchFromControls(push) {
  clearTimeout(debounceTimer);
  state.query = el.query.value;
  state.type = el.type.value;
  state.caseId = el.caseId.value;
  state.duplicates = el.duplicates.checked;
  state.page = 1;
  writeUrl(push);
  runSearch();
}

function searchAfterPause() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => searchFromControls(false), DEBOUNCE_MS);
}

function goToPage(page) {
  state.page = Math.min(Math.max(1, page), lastPage);
  writeUrl(true);
  runSearch();
  window.scrollTo(0, 0);
}

// Back and forward buttons: the address changed, so the view follows it. Only the part
// that really changed is loaded again, so closing a finding does not redraw the list.
function showStateFromUrl() {
  clearTimeout(debounceTimer);
  const searchBefore = searchPath();
  const selectedBefore = state.selected;
  readStateFromUrl();
  syncControls();
  if (searchPath() !== searchBefore) runSearch();
  if (state.selected !== selectedBefore) loadDetail();
}

// ---------- cases for the filter ----------

async function loadCases() {
  try {
    const body = await fetchJson("/api/cases");
    if (!Array.isArray(body.cases)) throw new Error("unexpected shape");
    const options = body.cases.map(
      (item) => optionNode(`${item.caseId} (${item.findings})`, item.caseId),
    );
    el.caseId.replaceChildren(optionNode("All cases", ""), ...options);
    showCaseInSelect();
  } catch {
    // The search still works without the list; say so instead of failing silently.
    el.caseError.hidden = false;
  }
}

// ---------- start ----------

function listenToControls() {
  el.query.addEventListener("input", searchAfterPause);
  el.query.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchFromControls(false);
  });
  el.type.addEventListener("change", () => searchFromControls(true));
  el.caseId.addEventListener("change", () => searchFromControls(true));
  el.duplicates.addEventListener("change", () => searchFromControls(true));
  el.retry.addEventListener("click", runSearch);
  el.previous.addEventListener("click", () => goToPage(state.page - 1));
  el.next.addEventListener("click", () => goToPage(state.page + 1));
  el.openAsId.addEventListener("click", () => selectFinding(state.query.trim()));
  el.closeDetail.addEventListener("click", closeDetail);
  // Escape closes the panel, but only when the focus is inside it: in the search box
  // Escape already means "clear the box".
  el.detail.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.selected !== "") closeDetail();
  });
  window.addEventListener("popstate", showStateFromUrl);
}

function start() {
  listenToControls();
  el.zoneNote.textContent = `Times in the list are in your local time zone (${timeZoneName()}).`;
  readStateFromUrl();
  syncControls();
  runSearch();
  loadDetail();
  loadCases();
}

start();
