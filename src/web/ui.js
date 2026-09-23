/* Plain read-only UI. All database/provider strings are text, never HTML/URLs.
 * Same-origin GET polling deliberately avoids EventSource's Origin header.
 * One outstanding poll, 100-event retained window; full batches pause for paging.
 */
/** @typedef {import('../inspection.js').Inspection} Inspection */
/** @typedef {import('../inspection.js').EventRow} EventRow */
/** @typedef {{run: string, offset: number, cursor: number, events: EventRow[], discarded: number, paused: boolean, controller: AbortController, timer?: number, busy?: boolean, snapshotKey?: string, snapshot?: Inspection}} State */
/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const select = (id) => /** @type {HTMLSelectElement} */ ($(id));
/** @param {string} id */
const button = (id) => /** @type {HTMLButtonElement} */ ($(id));
const PAGE = 20;
const WINDOW = 100;
let runOffset = 0;
/** @type {AbortController | undefined} */
let listRequest;
/** @type {State | undefined} */
let current;
/** @type {Map<string, HTMLButtonElement>} */
const mapButtons = new Map();

/** @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {unknown} [text]
 * @param {string} [className]
 */
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
/** @param {unknown} value */
function pretty(value) {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "undefined");
}
/** @param {string | null} value
 * @returns {unknown} */
function parsed(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
/** @param {number | null} value */
function money(value) {
  return value == null
    ? "unknown (not zero)"
    : `$${Number(value).toFixed(6)} USD`;
}
/** @param {HTMLElement} parent
 * @param {string} title
 * @param {unknown} value */
function detail(parent, title, value) {
  const box = node("details");
  box.append(node("summary", title), node("pre", pretty(value)));
  parent.append(box);
}
/** @param {HTMLSelectElement} select
 * @param {[string, string][]} options
 * @param {string} [preferred] */
function selectOptions(select, options, preferred) {
  select.replaceChildren();
  for (const [value, label] of options) {
    const option = node("option", label);
    option.value = value;
    select.append(option);
  }
  if (preferred !== undefined && options.some(([value]) => value === preferred))
    select.value = preferred;
}
/** @param {string} path
 * @param {AbortSignal} signal
 * @returns {Promise<unknown>} */
async function get(path, signal) {
  const response = await fetch(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    mode: "same-origin",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function loadRuns() {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  try {
    const rows = /** @type {import("../inspection.js").RunSummary[]} */ (
      await get(`/runs?offset=${runOffset}&limit=${PAGE}`, request.signal)
    );
    if (request !== listRequest) return;
    selectOptions(
      select("runs"),
      [
        ["", "Select a run"],
        ...rows.map(
          (r) =>
            /** @type {[string, string]} */ ([r.id, `${r.id} — ${r.status}`]),
        ),
      ],
      current?.run,
    );
    $("runs-page").textContent =
      `Current page: offset ${runOffset}, ${rows.length} runs (newest first).`;
    button("runs-prev").disabled = runOffset === 0;
    button("runs-next").disabled = rows.length < PAGE;
    $("list-status").textContent = rows.length
      ? "Run list is refreshed manually; selected run updates live."
      : "No runs on this page.";
  } catch (error) {
    if (!request.signal.aborted)
      $("list-status").textContent =
        `Run list unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function stop() {
  if (!current) return;
  clearTimeout(current.timer);
  current.controller.abort();
  current = undefined;
}
function chooseRun() {
  stop();
  mapButtons.clear();
  const run = select("runs").value;
  $("workspace").hidden = !run;
  if (!run) return;
  current = {
    run,
    offset: 0,
    cursor: 0,
    events: [],
    discarded: 0,
    paused: false,
    controller: new AbortController(),
  };
  $("run-title").textContent = run;
  $("run-status").textContent = "Loading…";
  for (const id of [
    "action-detail",
    "turn-detail",
    "events",
    "run-error",
    "cost",
    "cost-kinds",
    "window-status",
    "execution-map",
    "session-links",
    "selection-label",
  ])
    $(id).replaceChildren();
  selectOptions(select("actions"), []);
  selectOptions(select("turns"), []);
  void poll(current);
}
/** @param {State} state
 * @param {Inspection} snapshot */
function renderSnapshot(state, snapshot) {
  const serialized = JSON.stringify(snapshot);
  if (state.snapshotKey === serialized) return;
  state.snapshotKey = serialized;
  state.snapshot = snapshot;
  $("run-status").textContent = snapshot.run
    ? `Status: ${snapshot.run.status}`
    : "Unknown run — no run record retained.";
  $("run-error").textContent =
    snapshot.run?.error === ""
      ? "Failure (empty error message)"
      : (snapshot.run?.error ?? "");
  const totals = snapshot.totals;
  $("cost").textContent =
    `KNOWN SUBTOTAL: ${money(totals.knownUsd)} · Unresolved invocations: ${totals.unresolved ?? "none recorded"} · Invocations: ${totals.invocations}`;
  $("cost-kinds").textContent =
    snapshot.costsByKind
      .map((c) => `${c.kind}: ${money(c.knownUsd)}`)
      .join(" · ") || "No final ledger costs recorded.";
  $("records-page").textContent =
    `Current page: offset ${state.offset}; ${snapshot.actions.length} actions, ${snapshot.invocations.length} invocations.`;
  button("records-prev").disabled = state.offset === 0;
  button("records-next").disabled =
    snapshot.actions.length < PAGE && snapshot.invocations.length < PAGE;
  const ids = [
    ...new Set([
      ...snapshot.actions.map((a) => a.id),
      ...snapshot.invocations.map((i) => i.action),
    ]),
  ];
  selectOptions(
    select("actions"),
    ids.map((id) => [
      id,
      `${id} — ${snapshot.actions.find((a) => a.id === id)?.status ?? "action outside page"}`,
    ]),
    select("actions").value,
  );
  // Keep expanded receipt/accounting details through status-only polling updates.
  const expanded = ["action-detail", "turn-detail"].map((id) => ({
    id,
    titles: [...$(id).querySelectorAll("details[open] > summary")].map(
      (e) => e.textContent,
    ),
  }));
  renderMap(snapshot);
  renderAction(state);
  for (const { id, titles } of expanded) {
    for (const box of $(id).querySelectorAll("details")) {
      box.open = titles.includes(
        box.querySelector("summary")?.textContent ?? "",
      );
    }
  }
}
/** @param {State} state */
function renderAction(state) {
  const id = select("actions").value;
  const action = state.snapshot?.actions.find((a) => a.id === id);
  const area = $("action-detail");
  area.replaceChildren();
  if (action) {
    if (action.error !== null)
      area.append(
        node("pre", action.error || "Failure (empty error message)", "error"),
      );
    const result =
      /** @type {import("../types.js").CommandResult | import("../types.js").AgentResult | null} */ (
        parsed(action.result)
      );
    if (result && typeof result === "object" && "stdout" in result) {
      area.append(
        node("h3", "Retained command output"),
        node(
          "p",
          `Exit: ${result.code ?? "unknown"} · Signal: ${result.signal ?? "none"} · Cancelled: ${result.cancelled}`,
        ),
      );
      area.append(node("pre", result.stdout), node("pre", result.stderr));
      if (result.truncated)
        area.append(
          node(
            "p",
            "TRUNCATED command output — retained prefix only",
            "warning",
          ),
        );
    } else if (result && typeof result === "object" && "text" in result) {
      area.append(
        node("h3", "Retained action response"),
        node("pre", result.text),
      );
    } else
      area.append(
        node(
          "p",
          "No retained action result. Check durable invocation receipts below, including failed actions.",
        ),
      );
    if (result != null) detail(area, "Raw action result", result);
  } else area.append(node("p", "No action record on this page."));
  const invocations =
    state.snapshot?.invocations.filter((i) => i.action === id) ?? [];
  selectOptions(
    select("turns"),
    invocations.map((i) => [
      i.id,
      `Turn ${i.turn} · ${i.kind} · ${i.status} · ${i.id}`,
    ]),
    select("turns").value,
  );
  renderTurn(state);
}
/** @param {State} state */
function renderTurn(state) {
  const invocation = state.snapshot?.invocations.find(
    (i) => i.id === select("turns").value,
  );
  const area = $("turn-detail");
  area.replaceChildren();
  if (invocation) {
    const receipt = /** @type {import("../types.js").Receipt | null} */ (
      parsed(invocation.receipt)
    );
    const accounting = /** @type {import("../types.js").Accounting | null} */ (
      parsed(invocation.accounting)
    );
    area.append(
      node(
        "p",
        `Session handle: ${invocation.session ?? "none retained"} · Native session ID: ${receipt?.session?.nativeId ?? receipt?.nativeId ?? "none retained"}`,
      ),
    );
    area.append(
      node(
        "p",
        accounting
          ? `Primary cost: ${money(accounting.usd)} · ${accounting.status} · ${accounting.kind} · Model: ${accounting.model} · Scope: ${accounting.scope}`
          : "Accounting unresolved — no final ledger entry (not zero).",
      ),
    );
    if (receipt) {
      area.append(
        node("h3", `Retained final receipt · ${receipt.status}`),
        node("pre", receipt.text),
      );
      if (receipt.error) area.append(node("pre", receipt.error, "error"));
      if (receipt.truncated)
        area.append(
          node(
            "p",
            "TRUNCATED final response — retained prefix only",
            "warning",
          ),
        );
      detail(area, "Raw final receipt", receipt);
    } else
      area.append(
        node(
          "p",
          "No final receipt retained; invocation may still be running or uncertain.",
        ),
      );
    if (accounting)
      detail(
        area,
        "Final accounting (including exclusions / additional costs)",
        accounting,
      );
  } else
    area.append(
      node("p", "No invocation for this action on the current page."),
    );
  syncMapSelection();
  renderEvents(state);
}
/** @param {State} state */
function renderEvents(state) {
  const area = $("events");
  const expanded = new Set(
    [
      .../** @type {NodeListOf<HTMLDetailsElement>} */ (
        area.querySelectorAll("details[open]")
      ),
    ].map((d) => d.dataset.cursor),
  );
  area.replaceChildren();
  const rows = state.events.filter(
    (e) =>
      (!e.actionId || e.actionId === select("actions").value) &&
      (!e.invocationId || e.invocationId === select("turns").value),
  );
  $("window-status").textContent =
    `Loaded run window: ${state.events.length}/${WINDOW} observations; cursors ${state.events[0]?.cursor ?? "—"}–${state.cursor}. ${state.discarded} older loaded observations evicted. ${rows.length} match this selection. Earlier/later pages and unretained content are not shown. Absence of a marker does not prove completeness.`;
  if (!rows.length)
    area.append(
      node(
        "p",
        "No matching observations in the loaded window. Tracing may be off, absent, or outside this window.",
      ),
    );
  for (const event of rows) {
    const box = node("div", undefined, "observation");
    box.dataset.cursor = String(event.cursor);
    box.append(
      node(
        "p",
        `#${event.cursor} · ${event.type} · ${event.actionId ?? "run"} · turn ${event.turn ?? "—"} · ${new Date(event.observedAt).toLocaleTimeString()}`,
      ),
    );
    const metadata =
      event.data !== null &&
      typeof event.data === "object" &&
      !Array.isArray(event.data)
        ? event.data
        : {};
    if (metadata.contentOmitted)
      box.append(node("p", "CONTENT OMITTED — tracing off", "warning"));
    if (
      event.type === "trace.truncated" ||
      metadata.truncated === true ||
      JSON.stringify(event.data).includes('"projectionLoss":true') ||
      JSON.stringify(event.data).includes('"[bounded]"')
    )
      box.append(
        node(
          "p",
          "TRUNCATION indicator — retained prefix only; raw detail cannot restore omitted content",
          "warning",
        ),
      );
    const preview = pretty(event.data);
    box.append(
      node(
        "pre",
        preview.length > 1200
          ? `${preview.slice(0, 1200)}\n[UI preview clipped; expand raw detail]`
          : preview,
      ),
    );
    detail(
      box,
      `Raw observation · source ${event.sourceId ?? "not provided"}`,
      event,
    );
    const raw = /** @type {HTMLDetailsElement} */ (
      box.querySelector("details")
    );
    raw.dataset.cursor = String(event.cursor);
    raw.open = expanded.has(String(event.cursor));
    area.append(box);
  }
}
/** @param {Inspection} snapshot */
function renderMap(snapshot) {
  const board = $("execution-map");
  const links = $("session-links");
  const active = document.activeElement;
  const focusedKey =
    active instanceof HTMLElement ? active.dataset.mapKey : undefined;
  const scroll = board.scrollLeft;
  const panel = board.parentElement;
  const panelScroll = panel?.scrollTop ?? 0;
  mapButtons.clear();
  board.replaceChildren();
  links.replaceChildren();
  const model = executionMap(snapshot);
  const sessionLabels = new Map(
    [...model.sessions.keys()].map((id, i) => [id, `Session ${i + 1}`]),
  );
  if (!model.cards.length)
    board.append(node("p", "No action or invocation records on this page."));
  for (const [scope, cards] of model.lanes) {
    const lane = node("section", undefined, "flow-lane");
    lane.append(
      node("h3", scope === null ? "Unscoped actions" : `Scope: ${scope}`),
    );
    const track = node("div", undefined, "lane-track");
    for (const card of cards) {
      const kind = card.kinds.length
        ? card.kinds
            .map((k) =>
              k === "model"
                ? "Agent"
                : k === "command"
                  ? "Command / host check"
                  : k,
            )
            .join(" + ")
        : "Action · kind not loaded";
      const box = node(
        "article",
        undefined,
        `flow-card ${card.kinds.includes("command") ? "command-card" : card.kinds.includes("model") ? "agent-card" : "unknown-card"}`,
      );
      const pick = mapButton(card.id, null, "card");
      pick.className = "card-pick";
      pick.append(
        node("span", kind, "card-kind"),
        node("strong", card.label),
        node("span", card.id, "card-id"),
        node(
          "span",
          `Action: ${card.action?.status ?? "record outside page"}`,
          "card-status",
        ),
      );
      box.append(pick);
      box.append(
        node(
          "p",
          `Visible ledger subtotal: ${money(card.knownUsd)} · ${card.unresolved} unresolved loaded invocations. Partial, not an action total.`,
          "card-cost",
        ),
      );
      if (!card.invocations.length)
        box.append(
          node(
            "p",
            "No loaded invocations — kind, turns and cost coverage unknown.",
            "warning",
          ),
        );
      else {
        box.append(
          node(
            "p",
            `${card.invocations.length} loaded invocation(s) · turns within this action (gaps possible)`,
            "turn-caption",
          ),
        );
        const turns = node("div", undefined, "turn-track");
        for (const invocation of card.invocations) {
          const pickTurn = mapButton(card.id, invocation.id, "turn");
          pickTurn.textContent = `Turn ${invocation.turn} · ${invocation.status} · ${invocation.session === null ? "no session" : sessionLabels.get(invocation.session)}`;
          turns.append(pickTurn);
        }
        box.append(turns);
      }
      track.append(box);
    }
    lane.append(track);
    board.append(lane);
  }
  for (const [session, invocations] of model.sessions) {
    const rail = node("div", undefined, "session-rail");
    rail.append(
      node(
        "strong",
        `${sessionLabels.get(session)} · ${invocations.length} loaded member(s)`,
      ),
    );
    if (invocations.length === 1)
      rail.append(node("span", "No other member loaded."));
    for (const invocation of invocations) {
      const member = mapButton(invocation.action, invocation.id, "session");
      member.textContent = `${invocation.action} · turn ${invocation.turn}`;
      rail.append(member);
    }
    links.append(rail);
  }
  if (!model.sessions.size)
    links.append(node("p", "No session membership recorded in this page."));
  board.scrollLeft = scroll;
  if (panel) panel.scrollTop = panelScroll;
  if (focusedKey) mapButtons.get(focusedKey)?.focus({ preventScroll: true });
}
/** @param {string} action
 * @param {string | null} invocation
 * @param {string} placement */
function mapButton(action, invocation, placement) {
  const pick = node("button");
  const key = JSON.stringify([placement, action, invocation]);
  pick.dataset.mapKey = key;
  pick.dataset.action = action;
  if (invocation !== null) pick.dataset.invocation = invocation;
  pick.setAttribute("aria-controls", "action-detail turn-detail events");
  pick.addEventListener("click", () => {
    if (!current) return;
    select("actions").value = action;
    renderAction(current);
    if (invocation !== null) {
      select("turns").value = invocation;
      renderTurn(current);
    }
    document.querySelector(".detail-panel")?.scrollTo({ top: 0 });
  });
  mapButtons.set(key, pick);
  return pick;
}
function syncMapSelection() {
  const action = select("actions").value;
  const invocation = select("turns").value;
  $("selection-label").textContent = action
    ? `Action: ${action}`
    : "No action selected on this page.";
  for (const pick of mapButtons.values()) {
    const selected =
      pick.dataset.action === action &&
      (pick.dataset.invocation === undefined ||
        pick.dataset.invocation === invocation);
    pick.setAttribute("aria-pressed", String(selected));
  }
}
/** @param {State} state */
async function poll(state) {
  if (state !== current || state.busy) return;
  state.busy = true;
  const offset = state.offset;
  try {
    const query = `run=${encodeURIComponent(state.run)}`;
    const [snapshot, events] = await Promise.all([
      /** @type {Promise<Inspection>} */ (
        get(
          `/inspect?${query}&offset=${offset}&limit=${PAGE}`,
          state.controller.signal,
        )
      ),
      state.paused
        ? Promise.resolve([])
        : /** @type {Promise<EventRow[]>} */ (
            get(
              `/events?${query}&after=${state.cursor}&limit=${WINDOW}`,
              state.controller.signal,
            )
          ),
    ]);
    if (state !== current) return;
    for (const event of events) {
      if (event.cursor <= state.cursor) continue;
      state.cursor = event.cursor;
      state.events.push(event);
    }
    if (state.events.length > WINDOW) {
      state.discarded += state.events.length - WINDOW;
      state.events = state.events.slice(-WINDOW);
    }
    if (events.length === WINDOW) state.paused = true;
    if (offset === state.offset) renderSnapshot(state, snapshot);
    renderEvents(state);
    $("live-status").textContent = state.paused
      ? "History paging paused at a full batch — load next explicitly. Run status still polls."
      : "Live · same-origin polling every second · reconnects from last cursor, without duplicates.";
    button("events-next").disabled = !state.paused;
  } catch (error) {
    if (state !== current) return;
    $("live-status").textContent =
      `Disconnected: ${error instanceof Error ? error.message : String(error)}. Reconnecting from cursor ${state.cursor}…`;
  } finally {
    state.busy = false;
    if (state === current)
      state.timer = setTimeout(() => void poll(state), 1000);
  }
}
select("runs").addEventListener("change", chooseRun);
$("runs-refresh").addEventListener("click", () => void loadRuns());
button("runs-prev").addEventListener("click", () => {
  runOffset = Math.max(0, runOffset - PAGE);
  void loadRuns();
});
button("runs-next").addEventListener("click", () => {
  runOffset += PAGE;
  void loadRuns();
});
select("actions").addEventListener("change", () => {
  if (current) renderAction(current);
});
select("turns").addEventListener("change", () => {
  if (current) renderTurn(current);
});
for (const [id, delta] of /** @type {[string, number][]} */ ([
  ["records-prev", -PAGE],
  ["records-next", PAGE],
])) {
  $(id).addEventListener("click", () => {
    if (!current) return;
    current.offset = Math.max(0, current.offset + delta);
    clearTimeout(current.timer);
    void poll(current);
  });
}
button("events-next").addEventListener("click", () => {
  if (!current) return;
  current.paused = false;
  clearTimeout(current.timer);
  void poll(current);
});
window.addEventListener("pagehide", () => {
  stop();
  listRequest?.abort();
});
void loadRuns();
