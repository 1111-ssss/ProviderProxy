const LOG_PAGE_SIZE = 50
let logQuery = ""
let logFilter = "all"
let logPage = 0
let logLines = []

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
  const matching = logLines.filter(logMatches)
  const pages = Math.max(1, Math.ceil(matching.length / LOG_PAGE_SIZE))
  if (logPage >= pages) logPage = pages - 1
  const slice = matching.slice(logPage * LOG_PAGE_SIZE, (logPage + 1) * LOG_PAGE_SIZE)
  const atTop = box.scrollTop <= 60
  const previous = box.scrollTop
  box.replaceChildren(...(slice.length ? slice.map(logCard) : [logEmpty()]))
  box.scrollTop = atTop ? 0 : previous
  $("log-pager").innerHTML = pages > 1
    ? `<button type="button" data-page="${logPage - 1}"${logPage === 0 ? " disabled" : ""}>Назад</button><span class="muted">${logPage + 1} / ${pages}</span><button type="button" data-page="${logPage + 1}"${logPage === pages - 1 ? " disabled" : ""}>Вперёд</button>`
    : ""
  $("log-pager").querySelectorAll("[data-page]").forEach((button) => {
    button.onclick = () => {
      logPage = Number(button.dataset.page) || 0
      renderLogs()
      box.scrollTop = 0
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

