const LOG_PAGE_SIZE = 50
const LOG_FACET_PAGE_SIZE = 6
let logQuery = ""
let logFilters = new Set() // answer | switch | error | info
let logChatFilters = new Set()
let logModelFilters = new Set()
let logFacetDraft = null
let logFacetDrag = null
let logFacetView = "types"
let logFacetSearchOpen = { chats: false, models: false }
let logFacetSearch = { chats: "", models: "" }
let logFacetPage = { chats: 0, models: 0 }
// Recency ranks captured when the menu opens. Sorting once per opening keeps the
// list from jumping under the pointer while a tab is switched or a query typed.
let logFacetOrder = null
let logPage = 0
// Newest first by default; the setting flips the card order and swaps which
// end of the page the pager sits on.
let logReversed = appSettings().logsReversed === true
// One window of stored lines at a time. The day lives in SQLite; the GUI keeps
// what it has displayed, plus whatever it had to load to page further back, so
// searching and filtering still see every line the user has walked through.
const LOG_WINDOW = 500
let logLines = []
let logIds = []
let logHasMore = false
let logSessionTitles = {}
let logHasRenderedRecords = false

// The harness sends a shortened id, so a title keyed by the full id still fits.
function logSessionTitle(id) {
  if (!id) return ""
  const key = logSessionTitles[id] ? id : Object.keys(logSessionTitles).find((full) => full.startsWith(id))
  return key ? logSessionTitles[key] : ""
}

function logPageSlice(lines, page, size = LOG_PAGE_SIZE) {
  const start = page * size
  return lines.slice(start, start + size)
}

function logSessionId(line) {
  return String(line).match(/\[ses:([^\]]+)\]/)?.[1] ?? ""
}

// The requested name is the part before the arrow. Non-chat lines that also
// carry an arrow start with "image"/"GET"; everything else is a chat record.
function logRequestedModel(line) {
  const message = String(line).replace(/^\[[^\]]+\]\s*/, "").replace(/\s*\[ses:[^\]]+\]\s*$/, "")
  const split = message.indexOf(" → ")
  if (split < 0) return ""
  const requested = message.slice(0, split).trim()
  if (!requested || /^(?:image\b|GET\s|POST\s)/i.test(requested)) return ""
  return requested
}

function logFacets(lines, titles = logSessionTitles) {
  const chats = new Map()
  const models = new Set()
  for (const line of lines) {
    const id = logSessionId(line)
    if (id) {
      const title = titles[id] ?? Object.entries(titles).find(([full]) => full.startsWith(id))?.[1] ?? ""
      chats.set(id, { id, label: title || id, tip: title ? `${title} · ${id}` : id })
    }
    const model = logRequestedModel(line)
    if (model) models.add(model)
  }
  return {
    chats: [...chats.values()],
    models: [...models],
  }
}

/// Recency rank per chat and model. Lines arrive newest first, so the first
/// sighting of a value is its last activity; a lower rank means more recent.
function logFacetOrderSnapshot(lines = logLines) {
  const chats = new Map()
  const models = new Map()
  lines.forEach((line, index) => {
    const id = logSessionId(line)
    if (id && !chats.has(id)) chats.set(id, index)
    const model = logRequestedModel(line)
    if (model && !models.has(model)) models.set(model, index)
  })
  return { chats, models }
}

function logType(line) {
  const text = String(line).toLowerCase()
  // A skipped stream frame is a warning worth seeing, not a failed request:
  // the proxy logs it with an explicit "инфо" marker so it keeps its own kind
  // instead of landing in errors.
  if (/→\s*инфо:/.test(text)) return "info"
  if (text.includes("ответ")) return "answer"
  if (text.includes("свитч") || text.includes("заблокирован")) return "switch"
  if (text.includes("ошибк") || text.includes("error") || text.includes("пропущен")) return "error"
  return "info"
}

function logMatches(line) {
  const text = String(line).toLowerCase()
  if (logQuery) {
    const title = logSessionTitle(logSessionId(line)).toLowerCase()
    if (!text.includes(logQuery) && !title.includes(logQuery)) return false
  }
  if (logFilters.size && !logFilters.has(logType(line))) return false
  if (logChatFilters.size && !logChatFilters.has(logSessionId(line))) return false
  const model = logRequestedModel(line)
  if (logModelFilters.size && !logModelFilters.has(model)) return false
  return true
}

function logFilterActive() {
  return logFilters.size + logChatFilters.size + logModelFilters.size > 0
}

function syncLogFilterButton() {
  $("log-filter-menu").classList.toggle("is-active", logFilterActive())
}

function applyLogFacetDraft() {
  if (!logFacetDraft) return
  logFilters = new Set(logFacetDraft.types)
  logChatFilters = new Set(logFacetDraft.chats)
  logModelFilters = new Set(logFacetDraft.models)
  logPage = 0
  renderLogs()
}

function logFacetEntries(group) {
  const facets = logFacets(logLines)
  if (group === "types") return [["answer", "Ответы"], ["switch", "Переключения"], ["error", "Ошибки"], ["info", "Инфо"]].map(([value, label]) => ({ value, label, tip: label }))
  const order = logFacetOrder?.[group] ?? new Map()
  // Entries that appeared after the snapshot are the newest ones, so they lead.
  const byRecency = (a, b) => (order.get(a.value) ?? -1) - (order.get(b.value) ?? -1) || a.label.localeCompare(b.label, "ru")
  if (group === "chats") return facets.chats.map(({ id, label, tip }) => ({ value: id, label, tip })).sort(byRecency)
  return facets.models.map((model) => ({ value: model, label: model, tip: model })).sort(byRecency)
}

function logFacetSelection(group) {
  if (group === "types") return logFacetDraft?.types ?? logFilters
  if (group === "chats") return logFacetDraft?.chats ?? logChatFilters
  return logFacetDraft?.models ?? logModelFilters
}

/// Re-render the open menu and re-place it: switching to the paged views adds
/// a footer, so the height (and therefore the top) changes.
function refreshLogMenu() {
  renderLogFilterMenu(searchMenu)
  if (searchMenuAnchor) positionSearchMenu(searchMenuAnchor)
}

function renderLogFilterMenu(menu) {
  if (!logFacetDraft) logFacetDraft = { types: new Set(logFilters), chats: new Set(logChatFilters), models: new Set(logModelFilters) }
  const groups = [["types", "По типу"], ["chats", "По чатам"], ["models", "По моделям"]]
  const view = logFacetView
  const isPaged = view !== "types"
  const query = isPaged ? logFacetSearch[view].trim().toLowerCase() : ""
  const entries = logFacetEntries(view).filter((entry) => !query || `${entry.label} ${entry.tip}`.toLowerCase().includes(query))
  const pages = Math.max(1, Math.ceil(entries.length / LOG_FACET_PAGE_SIZE))
  logFacetPage[view] = Math.min(logFacetPage[view], pages - 1)
  const pageEntries = isPaged ? logPageSlice(entries, logFacetPage[view], LOG_FACET_PAGE_SIZE) : entries
  menu.className = "search-menu log-filter-menu"
  menu.innerHTML = `<div class="log-filter-tabs">${groups.map(([key, label]) => `<button type="button" data-log-view="${key}" class="${view === key ? "active" : ""}" aria-pressed="${view === key}">${label}</button>`).join("")}</div>
    <div class="log-facet-options" role="group" aria-label="${groups.find(([key]) => key === view)[1]}">${pageEntries.length ? pageEntries.map((entry) => `<label class="log-facet-option" data-log-value="${esc(entry.value)}" data-tip="${esc(entry.tip)}"><input type="checkbox" value="${esc(entry.value)}" ${logFacetSelection(view).has(entry.value) ? "checked" : ""}><span>${esc(entry.label)}</span></label>`).join("") : `<div class="empty-inline">${query ? "ничего не найдено" : "значений пока нет"}</div>`}</div>
    ${isPaged ? `<div class="log-facet-footer"><button type="button" data-facet-page="-1" aria-label="Предыдущая страница" ${logFacetPage[view] === 0 ? "disabled" : ""}>‹</button><button type="button" data-facet-search aria-label="${logFacetSearchOpen[view] ? "Скрыть поиск" : "Показать поиск"}" data-tip="${logFacetSearchOpen[view] ? "Скрыть поиск" : "Поиск"}" aria-pressed="${logFacetSearchOpen[view]}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg></button><button type="button" data-facet-page="1" aria-label="Следующая страница" ${logFacetPage[view] >= pages - 1 ? "disabled" : ""}>›</button></div>` : ""}
    ${isPaged && logFacetSearchOpen[view] ? `<input class="log-facet-search" type="search" aria-label="Поиск ${view === "chats" ? "чатов" : "моделей"}" placeholder="Поиск" value="${esc(logFacetSearch[view])}" autocomplete="off">` : ""}`
  menu.querySelectorAll("[data-log-view]").forEach((button) => button.onclick = () => { logFacetView = button.dataset.logView; refreshLogMenu() })
  menu.querySelectorAll(".log-facet-option").forEach((label) => {
    const checkbox = label.querySelector("input")
    const stage = (checked) => {
      const set = logFacetDraft[view]
      if (checked) set.add(checkbox.value)
      else set.delete(checkbox.value)
      checkbox.checked = checked
    }
    label.onpointerdown = (event) => {
      if (event.button !== 0) return
      logFacetDrag = { view, checked: !logFacetDraft[view].has(checkbox.value) }
      stage(logFacetDrag.checked)
    }
    label.onpointerenter = () => { if (logFacetDrag?.view === view) stage(logFacetDrag.checked) }
    // Every pointer pick is staged on pointerdown and applied on pointerup, so
    // the click is cancelled outright; the keyboard is handled on keydown.
    // (Clicking the label also forwards a click to this box, so a detail-based
    // check would double-toggle it.)
    checkbox.onclick = (event) => event.preventDefault()
    checkbox.onkeydown = (event) => {
      if (event.key !== " " && event.key !== "Enter") return
      event.preventDefault()
      const set = logFacetDraft[view]
      set.has(checkbox.value) ? set.delete(checkbox.value) : set.add(checkbox.value)
      checkbox.checked = set.has(checkbox.value)
      applyLogFacetDraft()
    }
  })
  menu.querySelectorAll("[data-facet-page]").forEach((button) => button.onclick = () => {
    logFacetPage[view] += Number(button.dataset.facetPage)
    refreshLogMenu()
  })
  menu.querySelector("[data-facet-search]")?.addEventListener("click", () => {
    logFacetSearchOpen[view] = !logFacetSearchOpen[view]
    if (!logFacetSearchOpen[view]) logFacetSearch[view] = ""
    logFacetPage[view] = 0
    refreshLogMenu()
    if (logFacetSearchOpen[view]) menu.querySelector(".log-facet-search")?.focus()
  })
  menu.querySelector(".log-facet-search")?.addEventListener("input", (event) => {
    logFacetSearch[view] = event.target.value
    logFacetPage[view] = 0
    refreshLogMenu()
    const input = menu.querySelector(".log-facet-search")
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  })
}

/// Releasing the pointer, even outside the menu, is what applies a drag pick.
function finishLogFacetDrag() {
  if (!logFacetDrag) return
  logFacetDrag = null
  applyLogFacetDraft()
}
document.addEventListener("pointerup", finishLogFacetDrag)
document.addEventListener("pointercancel", finishLogFacetDrag)

function renderLogs() {
  const box = $("logbox")
  syncLogFilterButton()
  const boxOverflow = getComputedStyle(box).overflowY
  const host = /auto|scroll/.test(boxOverflow) ? box : box.closest("section")
  const matching = logLines.filter(logMatches)
  // Only the loaded window is shown; the pager says how far back it goes and
  // loads the next window when the user reaches its end.
  const pages = Math.max(1, Math.ceil(matching.length / LOG_PAGE_SIZE))
  if (logPage >= pages) logPage = pages - 1
  const slice = logPageSlice(matching, logPage)
  const hostTop = host.getBoundingClientRect().top
  const visible = [...box.querySelectorAll(".log-card")].find((card) => card.getBoundingClientRect().bottom > hostTop)
  const anchorText = visible?.dataset.logLine
  const anchorOffset = visible ? visible.getBoundingClientRect().top - hostTop : 0
  const atTop = !logHasRenderedRecords || host.scrollTop <= 60
  // Mirrored logs: the pager sits above the list and search with filters moves
  // under it, so the reading order stays top-down in both directions.
  const section = box.closest("section")
  section.classList.toggle("logs-reversed", logReversed)
  const cards = slice.length ? slice.map(logCard) : [logEmpty()]
  box.replaceChildren(...(logReversed ? cards.reverse() : cards))
  if (atTop) host.scrollTop = 0
  else if (anchorText) {
    const anchor = [...box.querySelectorAll(".log-card")].find((card) => card.dataset.logLine === anchorText)
    if (anchor) host.scrollTop += anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - anchorOffset
  }
  if (slice.length) logHasRenderedRecords = true
  $("log-pager").innerHTML = pages > 1 || logHasMore
    ? `<button type="button" data-page="${logPage - 1}"${logPage === 0 ? " disabled" : ""}>Назад</button><span class="muted">${logPage + 1} / ${pages}</span><button type="button" data-page="${logPage + 1}"${logPage === pages - 1 && !logHasMore ? " disabled" : ""}>Вперёд</button>`
    : ""
  $("log-pager").querySelectorAll("[data-page]").forEach((button) => button.onclick = async () => {
    const target = Number(button.dataset.page) || 0
    // Walking past the loaded window fetches the next slice of the day first.
    if (target >= pages && logHasMore) await loadOlderLogs()
    logPage = Math.min(target, Math.max(0, Math.ceil(logLines.filter(logMatches).length / LOG_PAGE_SIZE) - 1))
    renderLogs()
    const scrollHost = /auto|scroll/.test(getComputedStyle(box).overflowY) ? box : box.closest("section")
    scrollHost.scrollTop = 0
  })
}

async function loadOlderLogs() {
  if (!logHasMore) return
  const before = logIds[logIds.length - 1]
  try {
    const j = await (await api(`/api/logs?before=${before}&limit=${LOG_WINDOW}`)).json()
    const older = Array.isArray(j.lines) ? j.lines : []
    // Same order as the first load: newest first.
    logLines = [...logLines, ...older.map((row) => row.line)]
    logIds = [...logIds, ...older.map((row) => row.id)]
    logHasMore = older.length >= LOG_WINDOW
    logSessionTitles = { ...logSessionTitles, ...(j.sessionTitles ?? {}) }
  } catch {
    /* прокси недоступен — следующий опрос повторит */
  }
}

async function loadLogs() {
  try {
    const j = await (await api(`/api/logs?limit=${LOG_WINDOW}`)).json()
    const rows = Array.isArray(j.lines) ? j.lines : []
    logSessionTitles = j.sessionTitles ?? {}
    if (!logIds.length) {
      logLines = rows.map((row) => row.line)
      logIds = rows.map((row) => row.id)
      logHasMore = Boolean(j.next)
    } else {
      // Poll only adds records that appeared since the last load. Rebuilding the
      // window would drop the older pages the user walked back to and shift the
      // page they are reading.
      const newest = logIds[0] ?? 0
      const fresh = rows.filter((row) => row.id > newest)
      if (fresh.length) {
        logLines = [...fresh.map((row) => row.line), ...logLines]
        logIds = [...fresh.map((row) => row.id), ...logIds]
        // Keep memory bounded: the window is a view, not a cache of the day.
        logLines = logLines.slice(0, LOG_WINDOW * 4)
        logIds = logIds.slice(0, LOG_WINDOW * 4)
      }
      logHasMore = logHasMore || Boolean(j.next)
    }
    // Old lines leave the buffer; a selection that no longer exists would hide
    // every record forever, so keep only values the new lines still contain.
    const facets = logFacets(logLines)
    const chats = new Set(facets.chats.map((chat) => chat.id))
    const models = new Set(facets.models)
    const kept = (set, allowed) => new Set([...set].filter((value) => allowed.has(value)))
    const chatsNext = kept(logChatFilters, chats)
    const modelsNext = kept(logModelFilters, models)
    const dropped = chatsNext.size !== logChatFilters.size || modelsNext.size !== logModelFilters.size
    logChatFilters = chatsNext
    logModelFilters = modelsNext
    if (logFacetDraft) {
      logFacetDraft.chats = kept(logFacetDraft.chats, chats)
      logFacetDraft.models = kept(logFacetDraft.models, models)
    }
    if (dropped) logPage = 0
    renderLogs()
    // Keep the open facet list in step with new lines, but never under the
    // pointer mid-drag or while the mini search is being typed into.
    if (!searchMenu.hidden && !logFacetDrag && logFacetView !== "types" && !logFacetSearchOpen[logFacetView]) refreshLogMenu()
  } catch {
    /* прокси недоступен — следующий опрос повторит */
  }
}

$("log-search").oninput = (event) => {
  logQuery = event.target.value.trim().toLowerCase()
  logPage = 0
  renderLogs()
}
$("log-search-clear").onclick = () => {
  logQuery = ""
  logFilters.clear()
  logChatFilters.clear()
  logModelFilters.clear()
  syncLogFilterButton()
  logPage = 0
  $("log-search").value = ""
  renderLogs()
  $("log-search").focus()
}
$("log-filter-menu").onclick = () => {
  // One ordering per opening: recency at the moment the menu was opened.
  logFacetOrder = logFacetOrderSnapshot()
  // Closing throws the draft away: reopening starts from the applied filters.
  openSearchMenuContent($("log-filter-menu"), renderLogFilterMenu, () => {
    logFacetDraft = null
    logFacetDrag = null
    logFacetOrder = null
  })
}


// Chat cards show the requested chain/model on its own line and any outcome
// details below it; the event kind is already shown by the badge.
const logCard = (line) => {
  const m = String(line).match(/^\[([^\]]+)\]\s*(.*)$/)
  const ts = m?.[1] ?? ""
  let rest = m?.[2] ?? line
  const sessionMatch = rest.match(/\s*\[ses:([^\]]+)\]\s*$/)
  const session = sessionMatch?.[1] ?? ""
  if (sessionMatch) rest = rest.slice(0, sessionMatch.index)
  const [head, ...tail] = rest.split(" → ")
  const detail = tail.join(" → ")
  const isChat = tail.length > 0
  // Other arrow lines (images, HTTP requests) keep the name on its own line.
  const chatKind = isChat && /^(?:ответ|свитч|ошибка|инфо)/.test(detail)
  const chatMessage = chatKind ? detail.replace(/^(?:ответ|свитч|ошибка|инфо)\s*:\s*/, "") : ""
  const [chatLabel = head, chatDescription = ""] = chatMessage.split(" — ", 2)
  const cls = /заблокирован|свитч/.test(line) ? "warn" : /401|ошибк|error/.test(line) ? "err" : /ответ/.test(line) ? "ok" : ""
  const card = document.createElement("div")
  card.className = "log-card" + (cls ? ` ${cls}` : "")
  card.dataset.logLine = String(line)
  const top = document.createElement("div")
  top.className = "t"
  const tm = document.createElement("span")
  tm.className = "tm"
  tm.textContent = ts
  top.append(tm)
  // The full session id, click to copy. Kept whole (with its ses_ prefix) so it
  // can be pasted straight into a tool; no underline, the pointer shows it is clickable.
  if (session) {
    const chip = document.createElement("span")
    chip.className = "ses"
    chip.textContent = session
    const title = logSessionTitle(session)
    chip.dataset.tip = title ? `${title} · нажми, чтобы скопировать id` : `скопировать ${session}`
    chip.dataset.sessionCopy = session
    top.append(chip)
  }
  const badge = document.createElement("span")
  badge.className = "b"
  // The badge is a short tag, not the whole message: a detail without a colon
  // used to become a one-line uppercase paragraph that overlapped the card.
  const tag = detail ? tail[0].replace(/[:：].*$/, "").trim() : ""
  const fallback = cls === "err" ? "ошибка" : cls === "warn" ? "блок" : "инфо"
  badge.textContent = tag && tag.length <= 24 ? tag : fallback
  badge.dataset.tip = tag
  top.append(badge)
  card.append(top)
  if (isChat && !chatKind) {
    const chain = document.createElement("div")
    chain.className = "chain"
    chain.textContent = head
    card.append(chain)
  } else if (chatKind) {
    const chain = document.createElement("div")
    chain.className = "chain"
    chain.textContent = chatLabel
    card.append(chain)
  }
  const msg = document.createElement("div")
  msg.className = "m"
  if (isChat) {
    msg.textContent = chatKind ? chatDescription : detail
  } else {
    const em = document.createElement("b")
    em.textContent = head
    msg.append(em)
  }
  if (!chatKind || chatDescription) card.append(msg)
  return card
}

const logEmpty = () => {
  const p = document.createElement("div")
  p.innerHTML = emptyStateHtml(logLines.length ? "ничего не найдено" : "записей пока нет")
  return p.firstElementChild
}
