const LOG_PAGE_SIZE = 50
let logQuery = ""
let logFilter = "all"
let logPage = 0
let logLines = []
let logHasRenderedRecords = false

function logPageSlice(lines, page, size = LOG_PAGE_SIZE) {
  const start = page * size
  return lines.slice(start, start + size)
}

function logMatches(line) {
  const text = String(line).toLowerCase()
  if (logQuery && !text.includes(logQuery)) return false
  if (logFilter === "answer") return text.includes("ответ")
  if (logFilter === "switch") return text.includes("свитч") || text.includes("заблокирован")
  if (logFilter === "error") return text.includes("ошибк") || text.includes("error") || text.includes("пропущен")
  return true
}

function renderLogs() {
  const box = $("logbox")
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
    $("log-info").textContent = `последние ${logLines.length} из ${j.max ?? "?"}`
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
$("log-filter").onchange = (event) => {
  logFilter = event.target.value
  logPage = 0
  renderLogs()
}

// Parse a line like "[2026-10-20 13:55:35] deepseek-v4.1-flash → свитч: ... [ses:ses_x]"
// into a card: the date sits on top with the session id and event badge to the
// right, the model/chain name goes on the next line, then the message.
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
    chip.title = `скопировать ${session}`
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
  badge.title = tag
  top.append(badge)
  card.append(top)
  // The model or chain name sits on its own line right under the date.
  if (isChat) {
    const chain = document.createElement("div")
    chain.className = "chain"
    chain.textContent = head
    card.append(chain)
  }
  const msg = document.createElement("div")
  msg.className = "m"
  if (isChat) {
    msg.textContent = detail
  } else {
    const em = document.createElement("b")
    em.textContent = head
    msg.append(em)
  }
  card.append(msg)
  return card
}

const logEmpty = () => {
  const p = document.createElement("div")
  p.className = "log-empty muted"
  p.textContent = "Ничего не найдено."
  return p
}
