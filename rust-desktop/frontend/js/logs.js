const LOG_PAGE_SIZE = 50
let logQuery = ""
// Checkbox filter: empty means every event, otherwise any picked kind matches.
let logFilters = new Set() // answer | switch | error
let logPage = 0
let logLines = []
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

function logMatches(line) {
  const text = String(line).toLowerCase()
  if (logQuery) {
    const sessionId = String(line).match(/\[ses:([^\]]+)\]/)?.[1] ?? ""
    const title = logSessionTitle(sessionId).toLowerCase()
    if (!text.includes(logQuery) && !title.includes(logQuery)) return false
  }
  const isAnswer = text.includes("ответ")
  const isSwitch = text.includes("свитч") || text.includes("заблокирован")
  const isError = text.includes("ошибк") || text.includes("error") || text.includes("пропущен")
  if (!logFilters.size) return true
  return (logFilters.has("answer") && isAnswer)
    || (logFilters.has("switch") && isSwitch)
    || (logFilters.has("error") && isError)
    // "Инфо" is the badge the card falls back to: anything with no outcome.
    || (logFilters.has("info") && !isAnswer && !isSwitch && !isError)
}

function renderLogs() {
  const box = $("logbox")
  syncFilterButton("log-filter-menu", logFilters)
  // Desktop scrolls the whole Logs section; narrow layouts constrain logbox.
  // Anchor the first visible card in whichever element actually scrolls so a
  // three-second refresh doesn't make the records jump under the pointer.
  const boxOverflow = getComputedStyle(box).overflowY
  const host = /auto|scroll/.test(boxOverflow) ? box : box.closest("section")
  const matching = logLines.filter(logMatches)
  const pages = Math.max(1, Math.ceil(matching.length / LOG_PAGE_SIZE))
  if (logPage >= pages) logPage = pages - 1
  // Page zero is newest, but entries within each page are chronological so
  // fresh lines arrive at the bottom and can be followed without rearranging
  // the older cards.
  const slice = logPageSlice(matching, logPage)
  const hostTop = host.getBoundingClientRect().top
  const visible = [...box.querySelectorAll(".log-card")].find((card) => card.getBoundingClientRect().bottom > hostTop)
  const anchorText = visible?.dataset.logLine
  const anchorOffset = visible ? visible.getBoundingClientRect().top - hostTop : 0
  const atTop = !logHasRenderedRecords || host.scrollTop <= 60
  box.replaceChildren(...(slice.length ? slice.map(logCard) : [logEmpty()]))
  if (atTop) {
    host.scrollTop = 0
  } else if (anchorText) {
    const anchor = [...box.querySelectorAll(".log-card")].find((card) => card.dataset.logLine === anchorText)
    if (anchor) host.scrollTop += anchor.getBoundingClientRect().top - host.getBoundingClientRect().top - anchorOffset
  }
  if (slice.length) logHasRenderedRecords = true
  $("log-pager").innerHTML = pages > 1
    ? `<button type="button" data-page="${logPage - 1}"${logPage === 0 ? " disabled" : ""}>Новее</button><span class="muted">${logPage + 1} / ${pages}</span><button type="button" data-page="${logPage + 1}"${logPage === pages - 1 ? " disabled" : ""}>Старее</button>`
    : ""
  $("log-pager").querySelectorAll("[data-page]").forEach((button) => {
    button.onclick = () => {
      logPage = Number(button.dataset.page) || 0
      renderLogs()
      const host = /auto|scroll/.test(getComputedStyle(box).overflowY) ? box : box.closest("section")
      host.scrollTop = 0
    }
  })
}

async function loadLogs() {
  try {
    const j = await (await api("/api/logs")).json()
    logLines = (j.lines ?? []).slice().reverse()
    logSessionTitles = j.sessionTitles ?? {}
    renderLogs()
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
  syncFilterButton("log-filter-menu", logFilters)
  logPage = 0
  $("log-search").value = ""
  renderLogs()
  $("log-search").focus()
}
$("log-filter-menu").onclick = () => {
  const options = [["answer", "Ответы"], ["switch", "Переключения"], ["error", "Ошибки"], ["info", "Инфо"]]
  openSearchMenu($("log-filter-menu"), options.map(([value, label]) => ({
    label, toggle: true, stayOpen: true, checked: logFilters.has(value),
    action: () => { toggleFilter("log-filter-menu", logFilters, value); logPage = 0; renderLogs() },
  })))
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
  const chatKind = isChat && /^(?:ответ|свитч|ошибка)/.test(detail)
  const chatMessage = chatKind ? detail.replace(/^(?:ответ|свитч|ошибка)\s*:\s*/, "") : ""
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
