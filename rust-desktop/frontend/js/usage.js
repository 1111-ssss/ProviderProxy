const fmtTok = (raw = 0) => {
  const n = Math.max(0, Number(raw) || 0)
  const units = [["", 1], ["k", 1e3], ["m", 1e6], ["b", 1e9], ["t", 1e12]]
  let i = 0
  while (i < units.length - 1 && n >= units[i + 1][1]) i++
  let value = n / units[i][1]
  let rounded = Number(value.toFixed(value >= 100 ? 0 : 1))
  // 999,999 should become 1m rather than 1000k after rounding.
  if (rounded >= 1000 && i < units.length - 1) {
    i++
    value = n / units[i][1]
    rounded = Number(value.toFixed(value >= 100 ? 0 : 1))
  }
  return `${rounded}${units[i][0]}`
}
const fmtNum = (n = 0) => Math.round(Number(n) || 0).toLocaleString("ru-RU")
const fmtUptime = (ms = 0) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${(s / 3600).toFixed(1)} ч`
}

function renderUsageCharts(u) {
  const requests = Math.max(0, Number(u.requests) || 0)
  const ok = Math.max(0, Number(u.ok) || 0)
  // The ring shows provider outcomes, not only what the client finally got: an
  // upstream that failed and then failed over is an error here, even though the
  // request ended successfully. Sum the provider error counters so the ring
  // matches the "Err" column in the provider table below it.
  const providerErrors = Object.values(u.providers ?? {}).reduce((sum, stat) => sum + (Number(stat.errors) || 0), 0)
  const errors = Math.max(0, providerErrors)
  const other = Math.max(0, requests - ok - errors)
  // One request can touch several upstreams, so the ring is measured in
  // attempts; the center number must match the segments instead of requests.
  const attempts = ok + errors + other
  const chartTotal = Math.max(1, attempts)
  const circumference = 2 * Math.PI * 43
  let offset = 0
  const segments = [
    ["u-donut-ok", ok],
    ["u-donut-failed", errors],
    ["u-donut-other", other],
  ]
  for (const [id, value] of segments) {
    const circle = $(id)
    const length = (value / chartTotal) * circumference
    circle.setAttribute("stroke-dasharray", `${length.toFixed(2)} ${circumference.toFixed(2)}`)
    circle.setAttribute("stroke-dashoffset", `${-offset.toFixed(2)}`)
    circle.style.opacity = value > 0 ? "1" : "0"
    offset += length
  }
  $("u-donut-skipped").style.opacity = "0"
  $("u-donut-total").textContent = fmtNum(attempts)
  $("u-outcome-note").textContent = `${fmtNum(requests)} запросов`
  // Percentages are relative to attempts, not to client requests: one request
  // can fail over several times, so the parts can exceed 100% of requests.
  const outcomeRows = [
    ["ok", "Успешные ответы", ok],
    ["failed", "Ошибки провайдеров", errors],
    ["other", "Прочее", other],
  ]
  $("u-outcome-legend").innerHTML = outcomeRows
    .map(([kind, label, value]) => {
      const percent = Math.round((value / chartTotal) * 100)
      return `<div class="legend-row"><span class="legend-dot ${kind}"></span><span class="legend-name">${label} · ${percent}%</span><span class="legend-value">${fmtNum(value)}</span></div>`
    })
    .join("")

  renderProviderProblemChart(u.providers)
}

// Provider health at a glance: one bar per provider, each bar full width and
// split by its own attempts. Scaling bars against the busiest provider made a
// provider with two failed calls look empty; here two failed calls are a
// solid red bar, which is what "100% проблемности" should look like.
function renderProviderProblemChart(obj) {
  const rows = Object.entries(obj ?? {})
    .map(([name, stat]) => {
      const requests = Number(stat.requests) || 0
      const ok = Number(stat.ok) || 0
      const limits = Number(stat.limits) || 0
      const errors = Number(stat.errors) || 0
      const other = Math.max(0, requests - ok - limits - errors)
      return { name, requests, ok, limits, errors, other }
    })
    // A provider with attempts but no result yet (still in flight, or the client
    // left) has nothing to show: an empty grey bar reads as "0% проблемности"
    // and only adds rows to the list.
    .filter((row) => row.ok + row.limits + row.errors > 0)
    .sort((a, b) => b.requests - a.requests)
  const width = (row, value) => Math.max(0, (value / row.requests) * 100).toFixed(1)
  $("u-token-chart").innerHTML = rows.length
    ? rows
        .map((row) => {
          const bad = row.limits + row.errors
          const problemRate = Math.round((bad / row.requests) * 100)
          const details = `${fmtNum(row.requests)} попыток: Ok ${fmtNum(row.ok)}, RateLimit ${fmtNum(row.limits)}, Err ${fmtNum(row.errors)}${row.other ? `, переключено ${fmtNum(row.other)}` : ""}`
          return `<div class="token-row" title="${esc(`${row.name} — ${details}`)}">
            <div class="token-row-head"><span>${esc(row.name)}</span><span class="problem-rate"><b style="color:${problemColor(problemRate)}">${problemRate}%</b> проблем</span></div>
            <div class="token-track"><span class="token-fill success" style="width:${width(row, row.ok)}%"></span><span class="token-fill limit" style="width:${width(row, row.limits)}%"></span><span class="token-fill error" style="width:${width(row, row.errors)}%"></span><span class="token-fill other" style="width:${width(row, row.other)}%"></span></div>
            <div class="token-row-foot"><span>Ok: ${fmtNum(row.ok)}</span><span>RateLimit: ${fmtNum(row.limits)}</span><span>Err: ${fmtNum(row.errors)}</span></div>
          </div>`
        })
        .join("")
    : `<div class="chart-empty">Данных о результатах пока нет</div>`
}

// Green at 0%, yellow at a quarter, red from half up — interpolated, so 30%
// and 45% do not both read as the same yellow.
// 0% green, 25% yellow, 50%+ red: a gradient, so 20% reads calmer than 30%.
// Kept low-saturation because it colours text, not a fill.
function problemColor(rate) {
  const clamped = Math.max(0, Math.min(50, Number(rate) || 0))
  const hue = clamped <= 25 ? 130 - clamped * 3.4 : 45 - (clamped - 25) * 1.8
  return `hsl(${hue.toFixed(0)} 48% 58%)`
}

// 24 slots, one per hour of the selected day. Bars share one scale so a busy
// hour visibly dominates; requests are a separate colour, not a second axis.
// A rolling 24 hours: the rightmost column is always the hour we are in, so the
// chart answers "what happened lately" instead of "what happened today by 03:00".
// Bars show input tokens only; everything else is spelled out in the hover hint.
function renderUsageHourChart(u, report, today) {
  const buckets = new Map(
    (Array.isArray(report?.days) ? report.days : []).map((day) => [day.date, day.hours ?? {}]),
  )
  if (u?.date) buckets.set(u.date, u.hours ?? {})
  // Today is the rolling last 24 hours, so the chart answers "what happened
  // lately" instead of "what happened today by 03:00". Any other day shows its
  // own 00:00–23:00, matching the provider table next to it.
  const selected = u?.date ?? ""
  const isToday = !selected || selected === today
  const now = new Date()
  const values = Array.from({ length: 24 }, (_, i) => {
    const at = isToday
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - (23 - i))
      : new Date(`${selected}T00:00:00`)
    if (!isToday) at.setHours(i)
    const key = String(at.getHours()).padStart(2, "0")
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
    const s = buckets.get(date)?.[key] ?? {}
    return {
      at,
      tin: Math.max(0, Number(s.tokensIn) || 0),
      tout: Math.max(0, Number(s.tokensOut) || 0),
      requests: Math.max(0, Number(s.requests) || 0),
      ok: Math.max(0, Number(s.ok) || 0),
      failed: Math.max(0, Number(s.failed) || 0),
    }
  })
  const maxTokens = Math.max(1, ...values.map((v) => v.tin))
  $("u-hour-title").textContent = isToday ? "Последние 24 часа" : "Часы этого дня"
  const label = (at) => (at.getHours() === 0 ? `${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")}` : String(at.getHours()).padStart(2, "0"))
  $("u-hour-chart").innerHTML = values
    .map((v, i) => {
      const empty = !v.tin && !v.tout && !v.requests
      const time = `${String(v.at.getHours()).padStart(2, "0")}:00`
      const lines = [
        `вход ${fmtTok(v.tin)}`,
        `выход ${fmtTok(v.tout)}`,
        `запросов ${fmtNum(v.requests)}`,
        `Ok ${fmtNum(v.ok)}`,
        `Err ${fmtNum(v.failed)}`,
      ]
      const hint = `${time} — ${lines.join(", ")}`
      // Right-edge columns extend the hint leftwards, left-edge ones rightwards;
      // the middle ones stay centred over the column.
      const edge = i >= 20 ? " hour-hint-right" : i <= 3 ? " hour-hint-left" : ""
      return `<div class="hour-col${empty ? " empty" : ""}" tabindex="0" aria-label="${esc(hint)}">
        <span class="hour-hint${edge}"><strong class="hour-hint-time">${time}</strong>${lines.map((line) => `<span>${line}</span>`).join("")}</span>
        <div class="hour-col-stack"><span class="hour-bar" style="height:${((v.tin / maxTokens) * 100).toFixed(1)}%"></span></div>
        <span class="hour-label">${label(v.at)}</span>
      </div>`
    })
    .join("")
  // The hint used to sit above the whole 150px column, so the numbers appeared
  // far from the pointer. Anchor it to the cursor and keep it inside the card.
  $("u-hour-chart").onpointermove = (event) => {
    const col = event.target.closest?.(".hour-col")
    const hint = col?.querySelector(".hour-hint")
    if (!col || !hint) return
    const card = col.closest(".chart-card")?.getBoundingClientRect()
    const colBox = col.getBoundingClientRect()
    const box = hint.getBoundingClientRect()
    if (!card || !box.width) return
    const half = box.width / 2 + 6
    const left = Math.min(
      Math.max(event.clientX - colBox.left, card.left + half - colBox.left),
      card.right - half - colBox.left,
    )
    const top = Math.max(event.clientY - colBox.top, box.height + 10)
    hint.style.left = `${left}px`
    hint.style.setProperty("--hint-y", `${top}px`)
  }
  // Keyboard focus has no pointer: fall back to a centred hint above the column.
  $("u-hour-chart").onfocusin = (event) => {
    const hint = event.target.closest?.(".hour-col")?.querySelector(".hour-hint")
    if (!hint) return
    hint.style.left = ""
    hint.style.removeProperty("--hint-y")
  }
}

// Compact two-row-per-record table: Имя | Req | OK/429/Err | вход/выход.
// Errors hide inside one cell so a long list stays readable without a scroll
// bar; the title attribute still spells the exact counts out.
function usageCompactTable(obj) {
  const rows = Object.entries(obj ?? {})
    // A row needs a recorded outcome to say anything. Requests without ok, limit
    // or err are attempts that never resolved (and old rows written before the
    // pass-through fix); they only add noise, so the table matches the chart.
    .filter(([, stat]) => {
      const outcome = (Number(stat.ok) || 0) + (Number(stat.limits) || 0) + (Number(stat.errors) || 0)
      const tokens = (Number(stat.tokensIn) || 0) + (Number(stat.tokensOut) || 0)
      return outcome > 0 || tokens > 0
    })
    .sort(([, a], [, b]) => (b.requests ?? 0) - (a.requests ?? 0))
  if (!rows.length) return `<tr><td class="muted">данных пока нет</td></tr>`
  const cell = (name, stat) => {
    const requests = Number(stat.requests) || 0
    const ok = Number(stat.ok) || 0
    const limits = Number(stat.limits) || 0
    const errors = Number(stat.errors) || 0
    const bad = limits + errors
    const problemRate = requests ? Math.round((bad / requests) * 100) : 0
    return `<tr>
      <td>${esc(name)}</td>
      <td class="muted">${fmtNum(requests)}</td>
      <td class="muted"><span class="${ok ? "ok-cell" : ""}">${fmtNum(ok)}</span><span class="sep">/</span><span class="${limits ? "warn" : ""}">${fmtNum(limits)}</span><span class="sep">/</span><span class="${errors ? "bad" : ""}">${fmtNum(errors)}</span>${bad ? `<small class="problem-rate" style="color:${problemColor(problemRate)}">${problemRate}%</small>` : ""}</td>
      <td class="muted">${fmtTok(stat.tokensIn)}<span class="sep">/</span>${fmtTok(stat.tokensOut)}</td>
    </tr>`
  }
  return `<tr><th>Имя</th><th>Req</th><th>OK<span class="sep">/</span>ratelimit<span class="sep">/</span>Err</th><th>Ток. вход<span class="sep">/</span>выход</th></tr>${rows.map(([name, stat]) => cell(name, stat)).join("")}`
}

function usageTable(obj, cols) {
  const names = Object.keys(obj ?? {}).sort((a, b) => (obj[b].requests ?? 0) - (obj[a].requests ?? 0))
  if (!names.length) return `<tr><td class="muted">данных пока нет</td></tr>`
  return (
    `<tr><th>имя</th>${cols.map((c) => `<th>${c.h}</th>`).join("")}</tr>` +
    names.map((n) => `<tr><td>${esc(n)}</td>${cols.map((c) => `<td class="muted">${c.f(obj[n])}</td>`).join("")}</tr>`).join("")
  )
}

// The harness name is a label: when it is missing the row shows the session id.
// The harness sends a shortened id, so a title keyed by the full id still fits.
function sessionTitle(titles, id) {
  if (!titles) return ""
  const key = titles[id] ? id : Object.keys(titles).find((full) => full.startsWith(id))
  return key ? titles[key] : ""
}
const SESSION_PAGE_SIZE = 20
let sessionQuery = ""
let sessionPage = 0
// Shared sort for both session tables (statistics tab and the "all sessions"
// dialog): clicking a header toggles asc/desc, the arrow shows the direction.
const sessionSort = { key: "lastSeen", dir: -1 }
const SESSION_SORT_KEYS = {
  requests: (stat) => Number(stat.requests) || 0,
  tokens: (stat) => Number(stat.tokensIn) || 0,
  duration: (stat) => Number(stat.activeMs) || 0,
  lastSeen: (stat) => Number(stat.lastSeen) || 0,
}
function sortSessionRows(rows) {
  const value = SESSION_SORT_KEYS[sessionSort.key] ?? SESSION_SORT_KEYS.lastSeen
  return rows.sort((a, b) => (value(a.stat) - value(b.stat)) * sessionSort.dir)
}
const sortArrow = (key) => (sessionSort.key === key ? (sessionSort.dir < 0 ? " ▾" : " ▴") : "")
function sortSessionHeader(key, label) {
  return `<th class="session-sort" data-sort="${key}" role="button" tabindex="0" aria-sort="${sessionSort.key === key ? (sessionSort.dir < 0 ? "descending" : "ascending") : "none"}">${label}${sortArrow(key)}</th>`
}
async function usageSessionRows(obj, titles) {
  const query = sessionQuery.trim().toLowerCase()
  return sortSessionRows(
    Object.entries(obj ?? {})
      .filter(([, stat]) => {
        const outcome = (Number(stat.ok) || 0) + (Number(stat.limits) || 0) + (Number(stat.errors) || 0)
        const tokens = (Number(stat.tokensIn) || 0) + (Number(stat.tokensOut) || 0)
        return outcome > 0 || tokens > 0
      })
      .map(([id, stat]) => ({ id, stat, title: sessionTitle(titles, id) }))
      .filter(({ id, title }) => !query || title.toLowerCase().includes(query) || id.toLowerCase().includes(query)),
  )
}
function usageSessionTable(rows, titles) {
  const all = usageSessionRows(rows, titles)
  const pages = Math.max(1, Math.ceil(all.length / SESSION_PAGE_SIZE))
  if (sessionPage >= pages) sessionPage = pages - 1
  const list = all.slice(sessionPage * SESSION_PAGE_SIZE, (sessionPage + 1) * SESSION_PAGE_SIZE)
  $("u-session-count").textContent = all.length ? `${all.length} сессий` : ""
  // Pages appear only past one page worth of sessions.
  $("u-session-pager").innerHTML = pages > 1
    ? `<button type="button" data-page="${sessionPage - 1}"${sessionPage === 0 ? " disabled" : ""}>Назад</button><span class="muted">${sessionPage + 1} / ${pages}</span><button type="button" data-page="${sessionPage + 1}"${sessionPage === pages - 1 ? " disabled" : ""}>Вперёд</button>`
    : ""
  $("u-session-pager").querySelectorAll("[data-page]").forEach((button) => {
    button.onclick = () => {
      sessionPage = Number(button.dataset.page) || 0
      renderUsageReportKeepingScroll(usageReport)
    }
  })
  return sessionTableHtml(list)
}

function sessionTableHtml(list) {
  if (!list.length) return `<tr><td class="muted">${sessionQuery ? "ничего не найдено" : "сессий пока нет"}</td></tr>`
  const when = (ms) => (ms ? new Date(Number(ms)).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—")
  const cell = ({ id, stat, title }) => `<tr>
      <td><span class="session-name" title="${esc(title || id)}" data-session-copy="${esc(id)}">${esc(title || id)}</span></td>
      <td class="muted">${fmtNum(stat.requests)}</td>
      <td class="muted">${fmtTok(stat.tokensIn)}<span class="sep">/</span>${fmtTok(stat.tokensOut)}</td>
      <td class="muted">${esc(fmtUptime(Number(stat.activeMs) || 0))}</td>
      <td class="muted">${esc(when(stat.lastSeen))}</td>
    </tr>`
  return `<tr><th>сессия</th>${sortSessionHeader("requests", "Req")}${sortSessionHeader("tokens", "Токены")}${sortSessionHeader("duration", "Длительность")}${sortSessionHeader("lastSeen", "Последний запрос")}</tr>${list.map(cell).join("")}`
}

// One document-level handler serves both tables, which are re-rendered often.
document.addEventListener("click", (event) => {
  const header = event.target.closest?.(".session-sort")
  if (!header) return
  const key = header.dataset.sort
  if (!(key in SESSION_SORT_KEYS)) return
  if (sessionSort.key === key) sessionSort.dir = -sessionSort.dir
  else {
    sessionSort.key = key
    sessionSort.dir = -1
  }
  sessionPage = 0
  allSessionPage = 0
  if (usageReport) renderUsageReportKeepingScroll(usageReport)
  if ($("dlg-all-sessions").open) renderAllSessions()
})

let usageReport = null
let usageDay = ""
let usageGroup = "overview"
const usageGroups = ["overview", "providers", "sessions", "images"]
const renderUsageGroups = () => {
  $("u-groups").querySelectorAll("[data-group]").forEach((button) => {
    const active = button.dataset.group === usageGroup
    button.classList.toggle("active", active)
    button.setAttribute("aria-selected", String(active))
  })
  document.querySelectorAll(".usage-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === usageGroup)
  })
}
const usageDayLabel = (date, today) => {
  if (date === today) return "Сегодня"
  return new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "")
}
const usageDayHasData = (day) => (Number(day.requests) || 0) + (Number(day.tokensIn) || 0) + (Number(day.tokensOut) || 0) + Object.keys(day.providers ?? {}).length + Object.keys(day.images ?? {}).length > 0

function renderUsageReport(report) {
  const days = Array.isArray(report.days) && report.days.length ? report.days : [{ date: report.today ?? "", ...report }]
  const today = report.today ?? days[0]?.date ?? ""
  if (!usageDay || !days.some((day) => day.date === usageDay)) usageDay = today
  $("u-days").innerHTML = days
    .map((day) => `<button type="button" class="usage-day${day.date === usageDay ? " active" : ""}${usageDayHasData(day) ? "" : " empty"}" data-date="${esc(day.date)}" role="tab" aria-selected="${day.date === usageDay}"><strong>${usageDayLabel(day.date, today)}</strong><small>${usageDayHasData(day) ? `${fmtNum(day.requests ?? 0)} запросов` : "нет запросов"}</small></button>`)
    .join("")
  // Days stretch across the whole row while they fit; the strip only scrolls
  // (by wheel too) once the window is narrow enough to clip them.
  const strip = $("u-days")
  strip.classList.toggle("is-overflowing", strip.scrollWidth > strip.clientWidth + 1)
  // A vertical wheel does not scroll a horizontal-only container in Chrome.
  strip.onwheel = (event) => {
    if (strip.scrollWidth <= strip.clientWidth) return
    event.preventDefault()
    strip.scrollLeft += event.deltaY + event.deltaX
  }
  $("u-days").querySelectorAll("[data-date]").forEach((button) => {
    button.onclick = () => {
      usageDay = button.dataset.date
      renderUsageReport(report)
    }
  })
  const selected = days.find((day) => day.date === usageDay) ?? days[0]
  const u = {
    ...selected,
    cooldowns: selected.date === today ? report.cooldowns ?? [] : [],
    uptimeMs: selected.date === today ? report.uptimeMs ?? 0 : 0,
  }
  $("u-info").textContent = selected.date === today
    ? `запущено: ${fmtUptime(u.uptimeMs)}`
    : (Number(selected.lastActivity) || 0) > (Number(selected.firstActivity) || 0)
      ? `работало: ${fmtUptime(Number(selected.lastActivity) - Number(selected.firstActivity))}`
      : ""
  const tile = (k, v) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`
  $("u-tiles").innerHTML =
    tile("запросов", u.requests ?? 0) +
    tile("успешных ответов", u.ok ?? 0) +
    tile("сбоев апстримов", u.failovers ?? 0) +
    tile("ошибок провайдеров", Object.values(u.providers ?? {}).reduce((sum, stat) => sum + (Number(stat.errors) || 0), 0)) +
    tile("токенов вход", fmtTok(u.tokensIn)) +
    tile("токенов выход", fmtTok(u.tokensOut))
  const lifetime = report.lifetimeTokens ?? {}
  if (lifetime.tokensIn || lifetime.tokensOut) {
    $("u-lifetime").textContent = `за всё время: ${fmtTok(lifetime.tokensIn)} вход · ${fmtTok(lifetime.tokensOut)} выход · ${fmtNum(lifetime.requests)} запросов`
  } else {
    $("u-lifetime").textContent = "за всё время: пока нет данных"
  }
  renderUsageCharts(u)
  renderUsageHourChart(u, report, today)
  renderUsageGroups()
  $("u-groups").querySelectorAll("[data-group]").forEach((button) => {
    button.onclick = () => {
      usageGroup = button.dataset.group
      renderUsageGroups()
    }
  })
  $("u-providers").innerHTML = usageCompactTable(u.providers)
  $("u-models").innerHTML = usageCompactTable(u.models)
  $("u-sessions").innerHTML = usageSessionTable(u.sessions, report.sessionTitles)
  const imageEntries = Object.entries(u.images ?? {}).sort(([, a], [, b]) => (b.requests ?? 0) - (a.requests ?? 0))
  $("u-image-tiles").innerHTML = tile("запросов", imageEntries.reduce((n, [, s]) => n + (s.requests ?? 0), 0)) + tile("сгенерировано", u.imagesGenerated ?? 0) + tile("успешных", imageEntries.reduce((n, [, s]) => n + (s.ok ?? 0), 0)) + tile("ошибок", imageEntries.reduce((n, [, s]) => n + (s.errors ?? 0), 0))
  const last = (value) => value?.provider && value?.model ? `${value.provider}/${value.model}` : "—"
  const recent = (u.recentImages ?? []).slice().reverse()
  $("u-image-recent").innerHTML = `<strong>Последние модели</strong><div class="muted" style="margin-top:6px">Последняя: ${esc(last(u.lastImageModel))} · последняя edit: ${esc(last(u.lastEditImageModel))}</div>${recent.length ? `<div class="provider-model-list" style="margin-top:10px">${recent.slice(0, 10).map((item) => `<span class="opencode-model"><strong>${esc(item.provider)}/${esc(item.model)}</strong><span>${esc(item.mode ?? "generate")} · ${esc(item.status ?? "pending")} · ${esc(item.at ?? "")}</span></span>`).join("")}</div>` : `<div class="muted" style="margin-top:6px">Изображений ещё не запускали.</div>`}`
  $("u-images").innerHTML = imageEntries.length
    ? `<tr><th>провайдер</th><th>модель</th><th>запросов</th><th>успешных</th><th>ошибок</th><th>последний HTTP</th></tr>${imageEntries.map(([, s]) => `<tr><td>${esc(s.provider)}</td><td>${esc(s.model)}</td><td class="muted">${s.requests ?? 0}</td><td class="muted">${s.ok ?? 0}</td><td class="muted">${s.errors ?? 0}</td><td class="muted">${s.lastStatus || "—"}</td></tr>`).join("")}`
    : `<tr><td class="muted">генераций пока не было</td></tr>`
}

// The 3-second poll rebuilds every block in place. Between two writes the page
// is momentarily shorter, and the browser clamps the scroll position to the new
// height — which felt like being thrown back to the top while reading. Remember
// both scroll owners and put them back after the render.
function renderUsageReportKeepingScroll(report) {
  const section = document.querySelector('main > section[data-tab="usage"]')
  const top = section?.scrollTop ?? 0
  const page = window.scrollY
  renderUsageReport(report)
  if (section) section.scrollTop = top
  if (window.scrollY !== page) window.scrollTo(0, page)
}

async function loadUsage() {
  try {
    usageReport = await (await api("/api/usage")).json()
    renderUsageReportKeepingScroll(usageReport)
  } catch {
    /* прокси недоступен — следующий опрос повторит */
  }
}

async function load() {
  try {
    const r = await api("/api/config")
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    cfg = await r.json()
    cfg.providers ??= {}
    cfg.models ??= {}
    cfg.opencodeModels ??= {}
    const chainsChanged = removeImageModelsFromChains()
    if (chainsChanged) save()
    renderAll()
    applyTheme(appSettings().theme)
    debugLog("boot-ok", { providers: Object.keys(cfg.providers).length, chains: Object.keys(cfg.models).length })
    // Providers bookmarked "all models" refresh before anything renders, so the
    // Connections list and the Models tab agree from the first paint. This is a
    // catalog refresh only: it must never tick models the user did not choose,
    // so the saved selection stays exactly as the config has it on first launch.
    syncAutoAllProviders({ refreshOnly: true }).then(() => {
      if (pmState.provider) loadPmModels(pmState.provider)
    })
    syncAutostartSetting()
    setTimeout(checkForDesktopUpdate, 1500)
  } catch {
    debugLog("boot-failed")
    flash(false, "не удалось загрузить конфиг — прокси запущен?")
  }
}

// Keep the local proxy warm while the GUI is open.
setInterval(() => fetch("/api/ping").catch(() => {}), 5000)

// Safety net: flush unsaved edits silently every five minutes.
setInterval(() => {
  if (configDirty) save(true)
}, 5 * 60 * 1000)
// Hourly: check for app updates and refresh the model lists of providers whose
// automatic selection is on. Skipped while the window is hidden (or minimized to
// the tray), so a background app does not wake for nothing. Providers refresh
// one after another to spare the network.
const hourlyMaintenance = () => {
  if (document.hidden) return
  checkForDesktopUpdate()
  syncAutoAllProviders()
}
setInterval(hourlyMaintenance, 60 * 60 * 1000)

// Logs and usage refresh every 3s, but only while the tab is visible.
setInterval(() => {
  if (document.hidden) return
  if (tab === "logs") loadLogs()
  if (tab === "usage") loadUsage()
}, 3000)

showTab(tab)
load()
