// The browser UI: search field, filters, the ledger of results and the record panel.
// An ES module, so the code runs in strict mode, after the page is parsed, and adds no
// global names.
//
// SECURITY: every finding text that comes from the API (entity, notes, source, the raw
// record) is untrusted. Some notes contain HTML and script on purpose. This file never
// turns a string into markup: every node is made with document.createElement and every
// text is set through textContent or createTextNode, so the browser shows such notes as
// the characters they are. Styling is done with class names only; the server's
// Content-Security-Policy forbids inline style and refuses HTML-from-string sinks.
//
// How the file is laid out: constants, the `state` object (the single source of truth),
// small helpers, the page address, the API, then one render function per part of the
// page, then the actions that change the state, the keyboard, and start().

const PAGE_SIZE = 50;
const TITLE = "Findings search";
// The server refuses a longer q with 400; the input has the same maxlength.
const MAX_QUERY = 200;
// Longest case id or record name accepted from the page address.
const MAX_NAME = 200;
// How long after the last result the screen reader is told about it: long enough that
// typing a word announces one summary, not one per letter.
const ANNOUNCE_MS = 500;
const COPIED_MS = 1600;
// ASCII control characters. A name with one of them cannot have been typed or shown.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// Flag name from the server -> [short label, one sentence for the record panel]. The
// order here is the order of the filter buttons.
const FLAG_TEXTS = new Map([
  ["reimport", ["re-import",
    "A copy of an earlier record that was imported again under a new id."]],
  ["duplicate-id", ["shared id",
    "An unrelated record has the same id; the key adds a number to tell them apart."]],
  ["id-missing", ["no id", "The record has no id; its key is its row number in the file."]],
  ["entity-missing", ["no entity", "The record has no entity text."]],
  ["entity-whitespace", ["entity had spaces",
    "The entity had spaces around it; they are left out for display and search."]],
  ["type-mismatch", ["type does not match entity",
    "The entity does not look like its type says; the type is shown as recorded."]],
  ["type-nonstandard", ["non-standard type label",
    "The type was written in another letter case or with spaces; it is read as that type."]],
  ["type-unknown", ["unknown type",
    "The recorded type is missing or is not one of the six known types."]],
  ["case-missing", ["no case", "The record names no case."]],
  ["case-nonstandard", ["non-standard case id",
    "The case id was written in another letter case or with spaces and is shown tidied."]],
  ["case-multiple", ["several cases",
    "The record belongs to more than one case and is counted in each of them."]],
  ["time-invalid", ["no valid time",
    "The observed time is missing or cannot be read without guessing."]],
  ["source-not-link", ["no source link",
    "The source is missing or is not an http(s) address; it is shown as text, not a link."]],
  ["notes-missing", ["no notes", "The record has no notes."]],
  ["notes-markup", ["markup in notes",
    "The notes contain something shaped like an HTML tag; it is shown as text and never run."]],
  ["notes-instructions", ["reads like instructions",
    "The notes address the reader instead of describing a finding. Found by keywords, so "
      + "it can be wrong; treat the note as data either way."]],
]);

const byId = (id) => document.getElementById(id);

const el = {
  band: byId("band"),
  query: byId("query"),
  types: byId("types"),
  flags: byId("flags"),
  flagsNone: byId("flags-none"),
  duplicates: byId("duplicates"),
  caseSelect: byId("case"),
  caseError: byId("case-error"),
  results: byId("results"),
  heading: byId("results-heading"),
  detail: byId("summary-detail"),
  message: byId("message"),
  rows: byId("rows"),
  pager: byId("pager"),
  previous: byId("previous"),
  next: byId("next"),
  range: byId("range"),
  record: byId("record"),
  recordBar: byId("record-bar"),
  recordStatus: byId("record-status"),
  closeRecord: byId("close-record"),
  recordEmpty: byId("record-empty"),
  recordContent: byId("record-content"),
  announcer: byId("announcer"),
};

// The type buttons are written in index.html; their values are the valid types.
const TYPES = [...el.types.children].map((button) => button.dataset.value);

// Everything the page shows follows from this object. The first seven fields are also
// kept in the page address (see writeAddress); the last two hold the server's answers.
const state = {
  query: "",
  type: "", // "" means all types
  flag: "", // "" means no data-quality filter
  caseId: "", // "" means all cases
  duplicates: false,
  page: 1,
  selected: "", // key or id of the record in the panel, "" when the panel is closed
  search: { status: "loading", total: 0, offset: 0, hits: [], facets: null, message: "" },
  record: { status: "closed", name: "", findings: [], message: "" },
};

// The same breakpoint as styles.css: below it the open record takes over the view.
const narrowScreen = window.matchMedia("(width < 56em)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let searchAbort = null; // AbortController of the search request in flight
let recordAbort = null; // the same for the record request
let announceTimer = 0;
let latestTransition = null;
let scrollBeforeRecord = 0; // where the list was scrolled to when a record took over
// The <li> of every result on the page, by finding key. Maps, because keys come from the
// data and a name like "__proto__" must not find anything on a plain object.
const rowsByKey = new Map();
const flagButtons = new Map();

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

// For text from the findings. The page says lang="en", but this text may be Estonian or
// anything else: an empty lang tells a screen reader "language unknown", and
// translate="no" keeps a browser translator from rewriting evidence.
function evidence(node) {
  node.setAttribute("lang", "");
  node.setAttribute("translate", "no");
  return node;
}

// A value an analyst may cite, in the monospace face.
function dataText(text) {
  return evidence(element("span", "data", text));
}

function optionNode(label, value) {
  const node = element("option", undefined, label);
  node.value = value;
  return node;
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
    fragment.append(text.slice(position, range.start));
    fragment.append(element("mark", undefined, text.slice(range.start, range.end)));
    position = range.end;
  }
  fragment.append(text.slice(position));
  return fragment;
}

function isUsableRange(range, position, length) {
  if (!Number.isInteger(range?.start) || !Number.isInteger(range?.end)) return false;
  return range.start >= position && range.end > range.start && range.end <= length;
}

// ---------- times ----------

// The server sends observedAt as UTC in one fixed form, 2026-10-27T11:58:07.000Z, so the
// UTC text is cut out of it: `length` 16 gives minutes, 19 gives seconds.
function utcText(iso, length) {
  return iso.slice(0, length).replace("T", " ");
}

function twoDigits(number) {
  return String(number).padStart(2, "0");
}

// The same moment on this computer's clock. Built by hand because toLocaleString gives a
// different order of day and month on different machines.
function localText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()];
  return `${day.map(twoDigits).join("-")} ${time.map(twoDigits).join(":")}`;
}

// ---------- the page address ----------

// "2" -> 2. Anything else ("-5", "1e3", "abc", "0", nothing) -> 1.
function pageNumberOf(value) {
  if (value === null || !/^\d{1,6}$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

// The address is typed, pasted and edited by people, so each value is checked before it
// becomes state. A value that fails falls back to the default instead of raising an error.
function readAddress() {
  const params = new URLSearchParams(location.search);
  const name = (key) => {
    const text = (params.get(key) ?? "").slice(0, MAX_NAME).trim();
    return CONTROL_CHARACTER.test(text) ? "" : text;
  };
  state.query = (params.get("q") ?? "").slice(0, MAX_QUERY);
  state.type = TYPES.includes(name("type")) ? name("type") : "";
  state.flag = FLAG_TEXTS.has(name("flag")) ? name("flag") : "";
  // The server compares case ids trimmed and in upper case; doing the same here lets
  // "c-101" in an address select the option "C-101".
  state.caseId = name("case").toUpperCase();
  state.duplicates = params.get("duplicates") === "1";
  state.page = pageNumberOf(params.get("page"));
  state.selected = name("selected");
}

// Only what differs from the default is written, so the plain view has a plain address.
function pageAddress() {
  const params = new URLSearchParams();
  if (state.query !== "") params.set("q", state.query);
  if (state.type !== "") params.set("type", state.type);
  if (state.flag !== "") params.set("flag", state.flag);
  if (state.caseId !== "") params.set("case", state.caseId);
  if (state.duplicates) params.set("duplicates", "1");
  if (state.page > 1) params.set("page", String(state.page));
  if (state.selected !== "") params.set("selected", state.selected);
  const search = params.toString();
  return search === "" ? location.pathname : `${location.pathname}?${search}`;
}

// push = true adds a step the Back button returns to: opening or closing a record (so
// Back closes it, which is what a phone user expects) and paging. Typing and filters
// replace the current step, so Back does not undo a search letter by letter.
function writeAddress(push) {
  showTitle();
  const address = pageAddress();
  if (address === location.pathname + location.search) return;
  try {
    if (push) history.pushState(null, "", address);
    else history.replaceState(null, "", address);
  } catch {
    // Safari refuses more than 100 address changes in 30 seconds. Nothing is lost: the
    // next change that goes through writes the whole state again.
  }
}

function showTitle() {
  const query = state.query.trim();
  document.title = query === "" ? TITLE : `${query} – ${TITLE}`;
}

// Copies the state into the controls; used at start and after Back or Forward.
function syncControls() {
  el.query.value = state.query;
  el.duplicates.checked = state.duplicates;
  showCaseInSelect();
  showTitle();
  renderFilters();
}

// A case from the address that is not in the list still gets an option, so the select
// never shows "All cases" while a case filter is in fact applied.
function showCaseInSelect() {
  const known = [...el.caseSelect.options].some((option) => option.value === state.caseId);
  if (!known) {
    el.caseSelect.append(optionNode(`${state.caseId} (not in the case list)`, state.caseId));
  }
  el.caseSelect.value = state.caseId;
}

// ---------- talking to the API ----------

// What went wrong with a request, with the HTTP status (0 when no answer arrived) and a
// message that can be shown to the analyst as it is.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function refusalText(status, said) {
  let what = "did not accept the request";
  if (status === 403) what = "refused the request";
  if (status === 404) what = "has nothing at this address";
  if (status >= 500) what = "failed";
  return `The server ${what} (${status}): ${said}`;
}

// Returns the parsed JSON or throws an ApiError. Only same-origin paths that start with
// /api/ are ever passed in.
async function fetchJson(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch {
    // fetch rejects when no answer arrived at all (server down, no network, cancelled).
    throw new ApiError(0, "Cannot reach the server. Check that it is running, then try again.");
  }
  // An error page from a proxy may not be JSON; then only the status is known.
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const said = typeof body?.error === "string" ? body.error : "no message";
    throw new ApiError(response.status, refusalText(response.status, said));
  }
  if (body === null) throw new ApiError(response.status, "The server's answer is not JSON.");
  return body;
}

// The API answers 400 to an empty type=, flag= or duplicates=, so unset filters are
// left out. URLSearchParams does the escaping.
function searchPath() {
  const params = new URLSearchParams();
  if (state.query.trim() !== "") params.set("q", state.query);
  if (state.type !== "") params.set("type", state.type);
  if (state.flag !== "") params.set("flag", state.flag);
  if (state.caseId !== "") params.set("case", state.caseId);
  if (state.duplicates) params.set("duplicates", "1");
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String((state.page - 1) * PAGE_SIZE));
  return `/api/findings?${params}`;
}

function lastPageOf(total) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

async function runSearch() {
  // Cancel the request this one overtakes. Without it a slow answer to "abc" could
  // arrive after the answer to "abcd" and replace the newer results.
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  // The previous rows stay on screen until the answer is here; see .summary-busy.
  el.results.setAttribute("aria-busy", "true");
  let search;
  try {
    const body = await fetchJson(searchPath(), controller.signal);
    if (!Array.isArray(body.hits) || !Number.isInteger(body.total)) {
      throw new ApiError(200, "The server sent an answer in an unexpected shape.");
    }
    const offset = Number.isInteger(body.offset) ? body.offset : 0;
    const facets = body.facets ?? null;
    search = { status: "ready", total: body.total, offset, hits: body.hits, facets, message: "" };
  } catch (error) {
    const message = error.message;
    search = { status: "error", total: 0, offset: 0, hits: [], facets: null, message };
  }
  // A cancelled request also ends here; a newer one is in charge of the screen then.
  if (controller.signal.aborted) return;
  // An address can ask for page 99 of 3. Show the last real page instead of an empty one.
  const lastPage = lastPageOf(search.total);
  if (search.status === "ready" && state.page > lastPage) {
    state.page = lastPage;
    writeAddress(false);
    await runSearch();
    return;
  }
  state.search = search;
  el.results.removeAttribute("aria-busy");
  renderFilters();
  renderResults();
  announceLater(announcementText());
}

// A screen reader hears the result of a search once it has settled. The visible summary
// cannot be the live region itself: it changes with every letter typed, and each change
// would be read out.
function announceLater(text) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    el.announcer.textContent = text;
  }, ANNOUNCE_MS);
}

async function fetchRecord(name, signal) {
  const missing = `No finding has the id “${name}”.`;
  // A browser reads "." and ".." in a path as "this folder" and "one up" and would ask
  // for another address altogether. No finding has such an id, so none is asked for.
  if (name === "." || name === "..") throw new ApiError(404, missing);
  try {
    // encodeURIComponent keeps a key with "/" or "?" in it inside one path segment.
    const body = await fetchJson(`/api/findings/${encodeURIComponent(name)}`, signal);
    if (Array.isArray(body.findings) && body.findings.length > 0) return body.findings;
    throw new ApiError(200, "The server sent an answer in an unexpected shape.");
  } catch (error) {
    throw error.status === 404 ? new ApiError(404, missing) : error;
  }
}

async function loadCases() {
  try {
    const body = await fetchJson("/api/cases");
    if (!Array.isArray(body.cases)) throw new ApiError(200, "unexpected shape");
    const options = body.cases.map(
      (item) => optionNode(`${item.caseId} (${item.findings})`, item.caseId),
    );
    el.caseSelect.replaceChildren(optionNode("All cases", ""), ...options);
    showCaseInSelect();
  } catch {
    // The search still works without the list; say so instead of failing silently.
    el.caseError.hidden = false;
  }
}

// ---------- render: filters ----------

// One button per flag, made once and then only shown, hidden and relabelled. Buttons
// that are never replaced can never lose the keyboard focus to a re-render.
function buildFlagButtons() {
  for (const [flag, [label]] of FLAG_TEXTS) {
    const node = element("button", "toggle", `${label} `);
    node.type = "button";
    node.dataset.value = flag;
    node.hidden = true;
    node.append(element("span", "count"));
    flagButtons.set(flag, node);
    el.flags.append(node);
  }
}

// A count from the server's facets, or null while it is not known.
function countOf(table, name) {
  const count = table?.[name];
  return Number.isInteger(count) ? count : null;
}

function showToggle(node, isPressed, count) {
  node.setAttribute("aria-pressed", String(isPressed));
  node.classList.toggle("is-empty", count === 0);
  node.lastElementChild.textContent = count === null ? "" : String(count);
}

// The count on a button is the total the analyst gets by pressing it: the server counts
// each type and each flag with all the other filters applied.
function renderFilters() {
  const facets = state.search.facets;
  for (const node of el.types.children) {
    const type = node.dataset.value;
    let count = countOf(facets?.types, type);
    // "All" is every type together.
    if (type === "" && facets !== null) {
      count = TYPES.reduce((sum, name) => sum + (countOf(facets.types, name) ?? 0), 0);
    }
    showToggle(node, state.type === type, count);
  }
  let shown = 0;
  for (const [flag, node] of flagButtons) {
    const count = countOf(facets?.flags, flag) ?? 0;
    // Only flags that occur in these results get a button. The active one stays so it
    // can be released, and the focused one stays so the focus is not dropped.
    const keep = count > 0 || state.flag === flag || node === document.activeElement;
    node.hidden = !keep;
    if (keep) shown += 1;
    showToggle(node, state.flag === flag, count);
  }
  el.flagsNone.hidden = shown > 0 || facets === null;
}

// ---------- render: summary, messages, rows, pager ----------

function countText(total) {
  return total === 1 ? "1 finding" : `${total} findings`;
}

function rangeText() {
  const { offset, hits } = state.search;
  return `${offset + 1}–${offset + hits.length}`;
}

// The words after the count: how the list is ordered, which part of it is on screen,
// and the time zone of the times, said once here instead of on every row.
function detailText() {
  const { status, total, hits } = state.search;
  if (status !== "ready" || total === 0) return "";
  const order = state.query.trim() === "" ? "newest first" : "best match first, then newest";
  const parts = [order, "times in UTC"];
  if (total > hits.length) parts.splice(1, 0, `showing ${rangeText()}`);
  return parts.join(" · ");
}

function announcementText() {
  const { status, total, message } = state.search;
  if (status === "error") return `The search failed. ${message}`;
  if (total === 0) return "No findings match.";
  const shown = total > state.search.hits.length ? `, showing ${rangeText()}` : "";
  return `${countText(total)}${shown}.`;
}

function renderResults() {
  const { status, total } = state.search;
  let heading = countText(total);
  if (status === "loading") heading = "Loading findings";
  if (status === "error") heading = "The search failed";
  el.heading.textContent = heading;
  el.detail.textContent = detailText();
  renderMessage();
  renderRows();
  renderPager();
}

function hasFilters() {
  return state.type !== "" || state.flag !== "" || state.caseId !== "";
}

// Shown in place of the rows: why there is nothing, and what to do about it.
function renderMessage() {
  const { status, total, message } = state.search;
  let nodes = [];
  if (status === "error") nodes = errorNodes(message, retrySearch);
  else if (status === "ready" && total === 0) nodes = noResultNodes();
  el.message.replaceChildren(...nodes);
  el.message.hidden = nodes.length === 0;
}

function errorNodes(message, onRetry) {
  return [element("p", "problem", message), button("button", "Try again", onRetry)];
}

function noResultNodes() {
  const query = state.query.trim();
  const nodes = [];
  if (query === "") {
    nodes.push(element("p", undefined, "No finding passes these filters."));
  } else {
    const where = hasFilters() ? " with these filters" : "";
    const line = element("p", undefined, "Nothing matches ");
    line.append(element("strong", undefined, query), `${where}.`);
    const advice = "Every word must be found in the entity, the notes or the source, or "
      + "be a whole id, case or type. Try fewer words, or one word without its ending.";
    nodes.push(line, element("p", "muted", advice));
  }
  const actions = element("p", "actions");
  if (hasFilters()) actions.append(button("button", "Clear the filters", clearFilters));
  if (actions.hasChildNodes()) nodes.push(actions);
  return nodes;
}

function focusedRowKey() {
  return document.activeElement?.closest(".row")?.dataset.key;
}

function renderRows() {
  // New rows replace the old ones. If the focus was on a row it moves to the same
  // finding in the new list, or to the heading: never to nowhere.
  const focusedKey = focusedRowKey();
  rowsByKey.clear();
  el.rows.replaceChildren(...state.search.hits.map(ledgerRow));
  markSelectedRow();
  if (focusedKey === undefined) return;
  const target = rowsByKey.get(focusedKey)?.querySelector(".entity") ?? el.heading;
  target.focus({ preventScroll: true });
}

// One finding in the list. The entity is the button that opens it; a click anywhere
// else on the row does the same (see onRowClick).
function ledgerRow(hit) {
  const finding = hit.finding;
  const row = element("li", "row");
  row.dataset.key = finding.key;

  const open = element("button", "entity");
  open.type = "button";
  if (finding.entity === "") open.textContent = "(no entity)";
  else evidence(open).append(highlighted(finding.entity, hit.entityRanges));

  const meta = element("div", "row-meta");
  const cases = finding.caseIds.length > 0 ? finding.caseIds.join(", ") : "no case";
  let time = element("span", undefined, "no valid time");
  if (finding.observedAt !== null) {
    time = element("time", "data", utcText(finding.observedAt, 16));
    time.dateTime = finding.observedAt;
  }
  const id = finding.id === "" ? element("span", undefined, "no id") : dataText(finding.id);
  const type = element("span", undefined, finding.type);
  const caseList = dataText(cases);
  markLabels(hit, { type, case: caseList, id });
  meta.append(type, caseList, time, id);

  const more = element("div", "row-more");
  if (finding.notes !== null) {
    const notes = evidence(element("p", "row-notes"));
    notes.append(highlighted(finding.notes, hit.notesRanges));
    more.append(notes);
  }
  // The source is on the row only when it is why the row is here. Text, not a link: the
  // link is made in the record panel, where the address is checked first.
  if (finding.sourceUrl !== null && hit.sourceRanges?.length > 0) {
    const source = evidence(element("p", "data"));
    source.append(highlighted(finding.sourceUrl, hit.sourceRanges));
    more.append(source);
  }
  if (finding.flags.length > 0) more.append(flagList(finding.flags));

  row.append(open, meta, more);
  rowsByKey.set(finding.key, row);
  return row;
}

// A type, case or id that a word of the query named as a whole is marked like any other
// match. `cells` maps the server's label names to the row's nodes for them.
function markLabels(hit, cells) {
  if (!Array.isArray(hit.matchedLabels)) return;
  for (const label of hit.matchedLabels) {
    const cell = Object.hasOwn(cells, label) ? cells[label] : undefined;
    if (cell === undefined) continue;
    const mark = element("mark", undefined, cell.textContent);
    cell.replaceChildren(mark);
  }
}

// A flag this file does not know yet is shown by its name instead of being dropped.
function flagLabel(flag) {
  return FLAG_TEXTS.get(flag)?.[0] ?? String(flag);
}

function flagList(flags) {
  const list = element("ul", "flags");
  list.setAttribute("aria-label", "Data-quality flags");
  for (const flag of flags) list.append(element("li", "flag", flagLabel(flag)));
  return list;
}

function markSelectedRow() {
  for (const [key, row] of rowsByKey) {
    const isSelected = key === state.selected;
    row.classList.toggle("is-selected", isSelected);
    const open = row.querySelector(".entity");
    if (isSelected) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
  }
}

function renderPager() {
  const { status, total } = state.search;
  const lastPage = lastPageOf(total);
  el.pager.hidden = status !== "ready" || lastPage === 1;
  el.range.textContent = `${rangeText()} of ${total}`;
  el.previous.disabled = state.page <= 1;
  el.next.disabled = state.page >= lastPage;
}

// ---------- render: the record panel ----------

function renderRecord() {
  const { status, findings, message } = state.record;
  const isOpen = status !== "closed";
  // On a narrow screen this class makes the panel take over the view (see styles.css).
  document.body.classList.toggle("record-open", isOpen);
  el.recordBar.hidden = !isOpen;
  el.recordEmpty.hidden = isOpen;
  el.recordContent.hidden = !isOpen;
  el.recordStatus.textContent = "";
  let nodes = [];
  if (status === "ready") nodes = recordNodes(findings);
  if (status === "error") nodes = recordErrorNodes(message);
  el.recordContent.replaceChildren(...nodes);
  el.record.removeAttribute("aria-busy");
  el.record.scrollTop = 0;
}

// The first heading of the panel takes the focus when a record opens, so a keyboard or
// screen-reader user lands on what was opened. tabindex -1: focusable, not a tab stop.
function panelTitle(text) {
  const title = element("h2", "record-title", text);
  title.tabIndex = -1;
  return title;
}

function recordErrorNodes(message) {
  const retry = () => loadRecord(true);
  return [panelTitle("This record cannot be shown"), ...errorNodes(message, retry)];
}

// The API returns a list: an id shared by unrelated records returns all of them.
function recordNodes(findings) {
  if (findings.length === 1) return [recordSheet(findings[0], true)];
  const title = panelTitle(`${findings.length} records share the id `);
  title.append(dataText(findings[0].id));
  const note = "They are unrelated findings that were given the same id. Each has its own "
    + "key; cite the key to name one of them.";
  const sheets = findings.map((finding) => recordSheet(finding, false));
  return [title, element("p", "muted", note), ...sheets];
}

// Highlights are reused from the list when the record is on the current page. The text
// is compared first: ranges cut into a different string would mark the wrong letters.
function listRanges(finding, field) {
  const hit = state.search.hits.find((item) => item.finding.key === finding.key);
  if (hit === undefined || hit.finding[field] !== finding[field]) return [];
  return field === "entity" ? hit.entityRanges : hit.notesRanges;
}

// One record. Alone in the panel its entity is the panel's title; among several records
// that share an id it is a heading one level down.
function recordSheet(finding, isAlone) {
  const sheet = element("article", "sheet");
  const title = isAlone ? panelTitle() : element("h3");
  title.classList.add("sheet-title");
  if (finding.entity === "") title.textContent = "(no entity)";
  else evidence(title).append(highlighted(finding.entity, listRanges(finding, "entity")));
  const head = element("div", "sheet-head");
  head.append(title);
  if (finding.entity !== "") head.append(copyButton(finding.entity, "entity"));

  const sectionTag = isAlone ? "h3" : "h4";
  // JSON.stringify gives undefined for a bare undefined; show that word then.
  const rawText = JSON.stringify(finding.raw, null, 2) ?? "undefined";
  sheet.append(
    head,
    fieldList(finding),
    element(sectionTag, "sheet-section", "Data quality"),
    flagExplanations(finding.flags),
    recordActions(finding),
    element(sectionTag, "sheet-section", "Record as it was received"),
    evidence(element("pre", "raw", rawText)),
  );
  return sheet;
}

function fieldList(finding) {
  const list = element("dl", "fields");
  const none = () => element("span", "muted", "none recorded");
  const cases = finding.caseIds.join(", ");
  const recordedSource = rawField(finding.raw, "sourceUrl");
  addField(list, "Type", typeValue(finding));
  addField(list, "Id", finding.id === "" ? none() : dataText(finding.id), finding.id);
  addField(list, "Key", dataText(finding.key), finding.key);
  addField(list, "Cases", cases === "" ? none() : dataText(cases));
  addField(list, "Observed", observedValue(finding));
  const source = sourceValue(finding.sourceUrl, recordedSource);
  addField(list, "Source", source, finding.sourceUrl ?? recordedSource);
  addField(list, "Notes", finding.notes === null ? none() : notesValue(finding));
  return list;
}

// `value` is a node built by this file. `copy`, when it is a non-empty string, is the
// exact text the field's Copy button puts on the clipboard.
function addField(list, label, value, copy) {
  const row = element("div", "field");
  const cell = element("dd");
  cell.append(value);
  if (typeof copy === "string" && copy !== "") {
    cell.append(copyButton(copy, label.toLowerCase()));
  }
  row.append(element("dt", undefined, label), cell);
  list.append(row);
}

function notesValue(finding) {
  const notes = evidence(element("p", "notes"));
  notes.append(highlighted(finding.notes, listRanges(finding, "notes")));
  return notes;
}

// One field of the raw record, or undefined. The raw record is whatever was in the input
// file: it may not be an object at all, and only its own fields are read.
function rawField(raw, name) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.hasOwn(raw, name) ? raw[name] : undefined;
}

// A recorded value as inert text in a box; the box makes spaces at its ends visible.
function rawValue(value) {
  if (value === undefined) return element("span", "muted", "(nothing)");
  if (value === "") return element("span", "muted", "(empty text)");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return evidence(element("code", "raw-value", text));
}

function typeValue(finding) {
  const value = element("span", undefined, finding.type);
  const differed = finding.flags.includes("type-nonstandard")
    || finding.flags.includes("type-unknown");
  if (differed) value.append(", recorded as ", rawValue(rawField(finding.raw, "type")));
  return value;
}

function observedValue(finding) {
  const value = element("span", "lines");
  if (finding.observedAt === null) {
    const recorded = rawValue(rawField(finding.raw, "observedAt"));
    value.append("No valid time. Recorded as ", recorded);
    return value;
  }
  const utc = element("time", "data", `${utcText(finding.observedAt, 19)} UTC`);
  utc.dateTime = finding.observedAt;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = element("span");
  local.append(dataText(`${localText(finding.observedAt)} ${zone}`));
  local.append(element("span", "muted", " (this computer)"));
  value.append(utc, local);
  return value;
}

// ---------- the source link ----------

// The URL when `text` is a web address that is safe to put in an href, otherwise null.
// The server already sets sourceUrl only for http(s) addresses; this checks again right
// where the link is made, because a javascript: or data: address in an href would run
// code when clicked.
function webUrl(text) {
  // "http:/x" and "http:x" also parse as http:, but a browser opens them relative to
  // this page's own address, so the text must itself start with the full scheme.
  if (typeof text !== "string" || !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function sourceValue(sourceUrl, recorded) {
  const url = webUrl(sourceUrl);
  if (url === null) {
    const value = element("span", "lines");
    const reason = element("span", "muted", `Not a link: ${whyNotLink(recorded)}.`);
    value.append(reason, rawValue(recorded));
    return value;
  }
  // The whole address is the link text, so the analyst sees where it leads before
  // clicking. The href is the parsed form: the browser opens exactly what was checked.
  const link = evidence(element("a", "data", sourceUrl));
  link.href = url.href;
  // A new tab, and the opened site gets neither a handle on this page nor its address.
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function whyNotLink(recorded) {
  if (recorded === undefined || recorded === null) return "no source was recorded";
  if (typeof recorded !== "string") return "the recorded value is not text";
  if (recorded.trim() === "") return "the recorded value is empty";
  if (!/^https?:\/\//i.test(recorded)) return "it does not start with http:// or https://";
  return "it is not a valid web address";
}

// ---------- flags and actions of a record ----------

function flagExplanations(flags) {
  if (flags.length === 0) return element("p", "muted", "No problems were found in this record.");
  const list = element("ul", "explanations");
  for (const flag of flags) {
    const sentence = FLAG_TEXTS.get(flag)?.[1] ?? "No explanation is available for this flag.";
    const item = element("li");
    item.append(element("span", "flag", flagLabel(flag)), ` ${sentence}`);
    list.append(item);
  }
  return list;
}

function recordActions(finding) {
  const actions = element("p", "actions");
  // A longer entity cannot be searched for: the server refuses a longer query.
  if (finding.entity !== "" && finding.entity.length <= MAX_QUERY) {
    const find = () => searchForEntity(finding.entity);
    actions.append(button("button", "Find all findings with this entity", find));
  }
  if (finding.duplicateOf !== null) {
    const original = finding.duplicateOf;
    const label = `Open the original record ${original}`;
    actions.append(button("button", label, () => openRecord(original)));
  }
  // The key of such a record is the id plus a number, so the id finds all its sharers.
  const sharesId = finding.flags.includes("duplicate-id") && finding.id !== "";
  if (sharesId && state.selected !== finding.id) {
    const label = `Show all records with id ${finding.id}`;
    actions.append(button("button", label, () => openRecord(finding.id)));
  }
  return actions;
}

// ---------- copying ----------

// `text` is the exact value and the only thing that ever reaches the clipboard. `what`
// names it for screen readers ("Copy entity") and for the status line.
function copyButton(text, what) {
  const node = button("button copy", undefined, () => copyText(node, text, what));
  node.append(element("span", undefined, "Copy"), element("span", "visually-hidden", ` ${what}`));
  return node;
}

async function copyText(node, text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard on a plain http address other than localhost, or permission refused.
    el.recordStatus.textContent = "Could not copy: the browser refused. Select the text instead.";
    return;
  }
  const said = `Copied the ${what}.`;
  node.firstElementChild.textContent = "Copied";
  node.classList.add("is-copied");
  el.recordStatus.textContent = said;
  setTimeout(() => {
    node.firstElementChild.textContent = "Copy";
    node.classList.remove("is-copied");
    if (el.recordStatus.textContent === said) el.recordStatus.textContent = "";
  }, COPIED_MS);
}

// ---------- motion ----------

// Runs `update` (a function that changes the page) inside a view transition, so the
// browser can animate from the old picture to the new one; styles.css says how. `kind`
// is "open", "close" or "step". Without the API, or when the analyst asked for reduced
// motion, the change simply happens. A newer transition ends an older one at once, so a
// fast run of key presses is never held up by an animation.
function withTransition(kind, update) {
  if (document.startViewTransition === undefined || reducedMotion.matches) {
    update();
    clearOrigin();
    return;
  }
  document.documentElement.dataset.motion = kind;
  const transition = document.startViewTransition(update);
  latestTransition = transition;
  // `ready` rejects when the transition is skipped; that is expected, not an error.
  transition.ready.catch(() => {});
  const tidy = () => {
    if (transition === latestTransition) clearOrigin();
  };
  transition.finished.then(tidy, tidy);
}

// The row whose entity travels to or from the panel title carries this class for the
// length of the transition. Both ends have the same view-transition-name in styles.css,
// and a name may be on one element only at a time.
function clearOrigin() {
  el.rows.querySelector(".is-origin")?.classList.remove("is-origin");
}

// ---------- actions: records ----------

function openRecord(name, { push = true, focusPanel = true } = {}) {
  state.selected = name;
  writeAddress(push);
  loadRecord(focusPanel);
}

function closeRecord() {
  state.selected = "";
  writeAddress(true);
  loadRecord(false);
}

// Brings the panel in line with state.selected. The row is marked at once; the panel
// changes when the record has arrived, so there is no flash of a loading state.
async function loadRecord(focusPanel) {
  recordAbort?.abort();
  markSelectedRow();
  const name = state.selected;
  if (name === "") {
    el.record.removeAttribute("aria-busy");
    showRecord({ status: "closed", name, findings: [], message: "" }, false);
    return;
  }
  const controller = new AbortController();
  recordAbort = controller;
  el.record.setAttribute("aria-busy", "true");
  let record;
  try {
    const findings = await fetchRecord(name, controller.signal);
    record = { status: "ready", name, findings, message: "" };
  } catch (error) {
    record = { status: "error", name, findings: [], message: error.message };
  }
  if (controller.signal.aborted) return;
  showRecord(record, focusPanel);
}

function showRecord(record, focusPanel) {
  const before = state.record;
  const wasOpen = before.status !== "closed";
  const isOpen = record.status !== "closed";
  if (!wasOpen && !isOpen) return;
  let kind = "step";
  if (!wasOpen) kind = "open";
  if (!isOpen) kind = "close";
  const hadFocus = el.record.contains(document.activeElement);
  const row = rowsByKey.get(isOpen ? record.name : before.name);
  clearOrigin();
  if (kind === "open") {
    row?.classList.add("is-origin");
    scrollBeforeRecord = window.scrollY;
  }
  withTransition(kind, () => {
    state.record = record;
    renderRecord();
    row?.classList.toggle("is-origin", kind === "close");
    if (kind === "close") {
      returnToList(row, hadFocus);
      return;
    }
    if (narrowScreen.matches) window.scrollTo(0, 0);
    if (focusPanel || hadFocus) {
      el.recordContent.querySelector("h2")?.focus({ preventScroll: true });
    }
  });
}

// After the panel closes: on a narrow screen the list comes back where it was, and the
// focus goes back to the row it came from, if closing left it without a place.
function returnToList(row, hadFocus) {
  if (narrowScreen.matches) window.scrollTo(0, scrollBeforeRecord);
  if (!hadFocus && document.activeElement !== document.body) return;
  const target = row?.querySelector(".entity") ?? el.heading;
  target.focus({ preventScroll: true });
  row?.scrollIntoView({ block: "nearest" });
}

// The list answers "which findings have this entity"; filters would hide some of them,
// and so would leaving the re-imported copies out.
function searchForEntity(entity) {
  Object.assign(state, { query: entity, type: "", flag: "", caseId: "", duplicates: true });
  state.page = 1;
  syncControls();
  // On a narrow screen the open record covers the list, so it makes way for the answer.
  if (narrowScreen.matches) closeRecord();
  else writeAddress(false);
  runSearch();
}

// ---------- actions: search, filters, pages ----------

function searchFromFirstPage() {
  state.page = 1;
  writeAddress(false);
  renderFilters();
  runSearch();
}

function onQueryInput() {
  state.query = el.query.value;
  searchFromFirstPage();
}

// One choice per row of buttons; pressing the active one again releases it.
function chooseFilter(name, event) {
  const node = event.target.closest("button");
  if (node === null) return;
  const value = node.dataset.value;
  state[name] = state[name] === value ? "" : value;
  searchFromFirstPage();
}

function clearFilters() {
  Object.assign(state, { type: "", flag: "", caseId: "" });
  syncControls();
  // The button that was pressed is about to be removed; the heading takes the focus.
  el.heading.focus();
  searchFromFirstPage();
}

function retrySearch() {
  el.heading.focus();
  runSearch();
}

function goToPage(page) {
  state.page = Math.min(Math.max(1, page), lastPageOf(state.search.total));
  writeAddress(true);
  // The top of the new page, for the eyes and for the keyboard.
  el.heading.focus();
  runSearch();
}

// A click anywhere on a row opens it, not only on the entity button.
function onRowClick(event) {
  const row = event.target.closest(".row");
  if (row === null) return;
  // Dragging over a note to select it also ends in a click; that must not open the row.
  const selection = window.getSelection();
  if (!selection.isCollapsed && row.contains(selection.anchorNode)) return;
  openRecord(row.dataset.key);
}

// Back and Forward: the address changed, so the view follows it. Only the part that
// really changed is loaded again, so closing a record does not redraw the list.
function onAddressChange() {
  const searchBefore = searchPath();
  const selectedBefore = state.selected;
  readAddress();
  syncControls();
  if (searchPath() !== searchBefore) runSearch();
  if (state.selected !== selectedBefore) loadRecord(true);
}

// ---------- keyboard ----------

// Moves through the rows by `step` (+1 or -1). The focus moves with it, and when a
// record is open the panel follows, as in a mail program with a preview pane.
function moveSelection(step) {
  const keys = state.search.hits.map((hit) => hit.finding.key);
  if (keys.length === 0) return;
  const inPanel = el.record.contains(document.activeElement);
  const from = keys.indexOf(focusedRowKey() ?? (inPanel ? state.selected : undefined));
  // From outside the list the first press lands on the open record's row, or the first.
  let to = Math.max(0, keys.indexOf(state.selected));
  if (from !== -1) to = Math.min(Math.max(0, from + step), keys.length - 1);
  const key = keys[to];
  const row = rowsByKey.get(key);
  if (inPanel) row.scrollIntoView({ block: "nearest" });
  else row.querySelector(".entity").focus();
  // Stepping replaces the address instead of adding to the history: Back should close
  // the record, not walk back through every row that was passed.
  if (state.selected !== "" && state.selected !== key) {
    openRecord(key, { push: false, focusPanel: inPanel });
  }
}

// +1, -1 or 0: whether this key press moves through the rows. j and k work anywhere
// outside a text field; the arrows only on a row (and Down in the search field), so that
// elsewhere they keep scrolling the page or the record.
function stepOf(event, inField) {
  const onRow = event.target.closest(".row") !== null;
  if (event.shiftKey) return 0;
  if (event.key === "j" && !inField) return 1;
  if (event.key === "k" && !inField) return -1;
  if (event.key === "ArrowDown" && (onRow || event.target === el.query)) return 1;
  if (event.key === "ArrowUp" && onRow) return -1;
  return 0;
}

function onEscape(event) {
  if (state.selected !== "") closeRecord();
  else if (event.target === el.query && el.query.value !== "") {
    el.query.value = "";
    onQueryInput();
  } else return;
  event.preventDefault();
}

function onKeydown(event) {
  // The shortcuts are single keys. With Ctrl, Alt or Meta the key belongs to the browser
  // or the system, and during IME composition it belongs to the input method.
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  const inField = event.target === el.query || event.target === el.caseSelect;
  const step = stepOf(event, inField);
  if (event.key === "Escape") {
    onEscape(event);
  } else if (event.key === "/" && !inField) {
    // Without this the "/" would also be typed into the field.
    event.preventDefault();
    el.query.focus();
    el.query.select();
  } else if (step !== 0) {
    event.preventDefault();
    moveSelection(step);
  }
}

// ---------- start ----------

function listen() {
  el.query.addEventListener("input", onQueryInput);
  el.types.addEventListener("click", (event) => chooseFilter("type", event));
  el.flags.addEventListener("click", (event) => chooseFilter("flag", event));
  el.duplicates.addEventListener("change", () => {
    state.duplicates = el.duplicates.checked;
    searchFromFirstPage();
  });
  el.caseSelect.addEventListener("change", () => {
    state.caseId = el.caseSelect.value;
    searchFromFirstPage();
  });
  el.rows.addEventListener("click", onRowClick);
  el.previous.addEventListener("click", () => goToPage(state.page - 1));
  el.next.addEventListener("click", () => goToPage(state.page + 1));
  el.closeRecord.addEventListener("click", closeRecord);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("popstate", onAddressChange);
}

// styles.css lets the record panel use the whole window height only once the top band
// has scrolled away; while the band is on screen the panel has to end above the footer.
function watchBand() {
  const observer = new IntersectionObserver(([entry]) => {
    document.body.classList.toggle("band-gone", !entry.isIntersecting);
  });
  observer.observe(el.band);
}

function start() {
  buildFlagButtons();
  listen();
  watchBand();
  readAddress();
  syncControls();
  renderResults();
  runSearch();
  loadRecord(true);
  loadCases();
}

start();
