// Uptime: the provider's own script decides what "uptime" means, the GUI only
// draws what it returns. The dialog shows one provider, the tab shows the cache
// the background round fills.

const dlgUptime = $("dlg-uptime")
let uptimeProvider = null
// The chosen window survives a refresh in the open dialog, and resets when the
// dialog is reopened for another provider.
let uptimeWindow = ""
// Last successful answer, so the window switch redraws without another run.
let uptimePayload = null
// When that answer was fetched: an open dialog may show a cached one instead of
// running the script again right after an automatic round.
let uptimePayloadAt = 0
// Milliseconds into "820 мс" / "1.2 с": a ping under a second reads better as ms.
const fmtUptimeMs = (value) => {
  const ms = Math.max(0, Number(value) || 0)
  return ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(1)} с`
}

// provider -> { at, payload } | { at, error }. The tab and the dialog read the
// same entry: opening a dialog right after a round does not run the script again.
const uptimeCache = new Map()
let uptimeRoundRunning = false
/// The catalog is re-read the first time the tab opens, not on every draw.
let uptimeCatalogLoaded = false
let uptimeLastRoundAt = 0
// The server kills a script after 60s, so a longer wait only stalls the queue.
const UPTIME_TIMEOUT_MS = 75000

/// Providers the user gave a script to. Everyone else has nothing to ask.
const uptimeProviders = () =>
  Object.entries(cfg.providers ?? {})
    .filter(([, provider]) => provider?.uptimeScript || provider?.uptimeScriptPath)
    .map(([name]) => name)

async function runUptime(provider) {
  const controller = new AbortController()
  // A hung provider must not hold the queue: the round moves on and the error
  // is cached like any other failure.
  const timer = setTimeout(() => controller.abort(), UPTIME_TIMEOUT_MS)
  try {
    const r = await api("/api/uptime/run", {
      method: "POST",
      body: JSON.stringify({ provider }),
      signal: controller.signal,
    })
    const payload = await r.json().catch(() => ({}))
    if (!r.ok) return { error: apiErrorMessage(payload, `HTTP ${r.status}`) }
    return { payload }
  } catch (error) {
    return { error: error?.name === "AbortError" ? "провайдер не ответил за 75 с" : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/// One round, strictly sequential: the scripts talk to different status pages,
/// and firing them together only makes them fight for the same limits.
async function refreshAllUptime() {
  if (uptimeRoundRunning) {
    debugLog("uptime-round-skipped")
    return false
  }
  const providers = uptimeProviders()
  if (!providers.length) return false
  uptimeRoundRunning = true
  uptimeLastRoundAt = Date.now()
  try {
    for (const provider of providers) {
      uptimeCache.set(provider, { ...(await runUptime(provider)), at: Date.now() })
      renderUptimeTab()
    }
  } finally {
    uptimeRoundRunning = false
    debugLog("uptime-round-done", { providers: providers.length })
  }
  // The chain ranks its models by this number, so the proxy gets the same data
  // the tab just drew.
  pushUptimeBars()
  return true
}

/// Hands the cached external uptime to the proxy. Best effort: the ranking
/// just keeps its defaults when this fails. Called after a round and when the
/// tab opens, so a reloaded GUI restores the numbers the proxy ranks by.
async function pushUptimeBars() {
  const bars = [...uptimeCache.entries()]
    .map(([provider, entry]) => ({
      provider,
      models: (entry?.payload?.bars ?? [])
        .filter((bar) => bar?.percent != null)
        .map((bar) => ({ model: bar.label, percent: Number(bar.percent) })),
    }))
    .filter((entry) => entry.models.length)
  if (!bars.length) return
  try {
    await api("/api/uptime/bars", { method: "POST", body: JSON.stringify({ bars }) })
  } catch {
    /* прокси недоступен — следующий раунд отправит снова */
  }
}

/// A script may report both windows; then the dialog and the tab offer a switch
/// and read `percent1h` / `percent24h` instead of the plain percentage.
const uptimeSharesBoth = (bars) => bars.some((bar) => bar.percent1h != null && bar.percent24h != null)
const uptimeBarPercent = (bar, window, both) => {
  if (!bar) return null
  const value = both ? bar[window === "1h" ? "percent1h" : "percent24h"] : null
  return value ?? bar.percent ?? null
}
const uptimeKind = (percent) => (percent >= 99 ? "success" : percent >= 90 ? "limit" : "error")

/// 0 % red, 50 % yellow, 100 % green, smoothly: three buckets made 96 % look
/// exactly like 100 % and 89 % exactly like 20 %.
const uptimeColor = (percent) =>
  `hsl(${percent <= 50 ? percent * 0.96 : 48 + (percent - 50) * 1.84} 62% 52%)`

/// "13:52" for today, "26.11 13:52" for anything older. An unparseable value is
/// shown as sent rather than replaced with "Invalid Date".
function uptimeTimeLabel(value, withDate = false) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value ?? "")
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
  return withDate || date.toDateString() !== new Date().toDateString()
    ? `${date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${time}`
    : time
}

/// The strip of boxes under a bar, one per interval, coloured by its own share.
/// A cell carries its time when the provider sent one, and the tooltip shows it.
/// A slot without a number is grey, never dropped: a hole in the middle of the
/// strip read as a shorter window, and the box count is what shows the interval.
function uptimeCellsHtml(cells, extraClass = "") {
  if (!Array.isArray(cells) || !cells.length) return ""
  const boxes = cells.map((cell) => {
    const has = cell?.percent != null
    const percent = Math.max(0, Math.min(100, Number(cell?.percent) || 0))
    const tip = [
      cell?.t ? uptimeTimeLabel(cell.t) : "",
      has ? `${percent.toFixed(1)}%` : "нет запросов",
      cell?.total ? `ответов ${cell.ok ?? 0} из ${cell.total}` : "",
    ].filter(Boolean).join(" · ")
    const kind = has ? ` ${uptimeKind(percent)}` : " empty"
    const style = has ? ` style="background:${uptimeColor(percent)}"` : ""
    return `<span class="uptime-cell${kind}" data-tip="${esc(tip)}"${style}></span>`
  })
  return `<div class="uptime-strip${extraClass ? ` ${extraClass}` : ""}"><div class="uptime-cells">${boxes.join("")}</div></div>`
}

/// Time to first token. The abbreviation means nothing outside the field, so the
/// row prints the Russian name and keeps "ttft" in the tooltip.
const UPTIME_TTFT_HINT = "ttft — время до первого токена"

/// One row for both surfaces: name, percentage, the strip of cells, and only the
/// metrics the script actually sent (an empty row would look like a zero). The
/// strip is the visual: a second progress bar above it drew the same number
/// twice and made a dense list noisy.
///
/// `answers` is the proxy's own count of that model's answers today, drawn as
/// a second, thinner strip under the script's one. A model with no recorded
/// answers has no such strip at all, so an empty line never reads as 0%.
function uptimeRowHtml(label, bar, percent, window, answers, fallbackCells = []) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  const own = (window === "1h" ? bar?.cells1h : bar?.cells24h) ?? bar?.cells ?? []
  // A model the script has no cells for still gets a strip: grey boxes the same
  // width as its neighbours, so a missing model reads as silence, not as a gap.
  const cells = own.length ? own : fallbackCells
  const metrics = [
    bar?.tps != null ? `${Number(bar.tps).toFixed(1)} ток/с` : "",
    bar?.ttftMs != null ? ["1-й токен", fmtUptimeMs(bar.ttftMs), UPTIME_TTFT_HINT] : null,
    bar?.latencyMs != null ? ["ping", fmtUptimeMs(bar.latencyMs), "задержка ответа"] : null,
  ].filter(Boolean)
  const answerPercent = window === "1h" ? answers?.percent1h : answers?.percent24h
  const recorded = answerPercent != null
    ? `<span class="uptime-row-answers" data-tip="${esc(`по ответам ${window === "1h" ? "за час" : "за сегодня"}: ${answers.ok} из ${answers.total}`)}">ответы ${answerPercent.toFixed(1)}%</span>`
    : ""
  return `<div class="uptime-row">
    <div class="uptime-row-head"><span class="uptime-row-name" data-tip="${esc(label)}">${esc(label)}</span><span class="uptime-row-numbers"><b class="uptime-row-percent ${uptimeKind(value)}" style="color:${uptimeColor(value)}">${value.toFixed(1)}%</b>${recorded}</span></div>
    ${uptimeStripLine(uptimeCellsHtml(cells), "Внешний")}
    ${uptimeAnswersStripHtml(answers, window)}
    ${metrics.length ? `<div class="uptime-row-foot">${metrics
      .map((metric) => Array.isArray(metric)
        ? `<span data-tip="${esc(metric[2])}">${esc(metric[0])} ${esc(metric[1])}</span>`
        : `<span>${esc(metric)}</span>`)
      .join("")}</div>` : ""}
  </div>`
}

/// The proxy's own strip, drawn from the same window the tab shows. The strip
/// is always full width, ending at the current slot, so the coloured cells sit
/// at the right and the slots without traffic stay grey boxes on the left: an
/// hour of silence is not the same thing as an hour of failures. A model with
/// no answers at all gets no strip — an all-grey line would read as data.
const uptimeAnswersStripHtml = (answers, window = "24h") => {
  if (!answers?.total) return ""
  const cells = window === "1h" ? answers.cells1h : answers.cells24h
  return cells?.length
    ? uptimeStripLine(uptimeCellsHtml(cells, "uptime-strip-answers"), "ответы")
    : ""
}

/// Two strips under a model need names: "скрипт" is what the provider's status
/// page says, "ответы" is what this proxy measured itself.
const uptimeStripLine = (strip, label) =>
  strip ? `<div class="uptime-strip-line"><span class="uptime-strip-tag">${label}</span>${strip}</div>` : ""


// --- Dialog -----------------------------------------------------------------

function openUptimeDialog(provider) {
  uptimeProvider = provider
  const cached = uptimeCache.get(provider)
  uptimePayload = cached?.payload ?? null
  uptimePayloadAt = cached?.at ?? 0
  dlgUptime.returnValue = ""
  $("uptime-title").textContent = `Аптайм · ${provider}`
  $("uptime-body").innerHTML = `<div class="empty-inline">запускаю скрипт…</div>`
  $("uptime-meta").textContent = ""
  dlgUptime.showModal()
  // A fresh cache entry is drawn as is: an automatic round just paid for it and
  // the refresh button is right there. Without one the script runs now.
  if (uptimePayload) renderUptimeBars()
  else loadUptime()
}

async function loadUptime() {
  if (!uptimeProvider) return
  const provider = uptimeProvider
  const body = $("uptime-body")
  body.innerHTML = `<div class="empty-inline">запускаю скрипт…</div>`
  const result = await runUptime(provider)
  const at = Date.now()
  uptimeCache.set(provider, { ...result, at })
  if (uptimeProvider !== provider) return // dialog switched or closed meanwhile
  if (result.error) {
    uptimePayload = null
    body.innerHTML = `<div class="empty-inline is-error">${esc(result.error)}</div>`
    return
  }
  uptimePayload = result.payload
  uptimePayloadAt = at
  renderUptimeBars()
  renderUptimeTab()
}

/// Draws the last payload. The window switch redraws this instead of re-running
/// the script: the script already had to fetch both windows to report them.
function renderUptimeBars() {
  const body = $("uptime-body")
  if (!uptimePayload) return
  const bars = uptimePayload.bars ?? []
  const both = uptimeSharesBoth(bars)
  const window = both ? uptimeWindow || uptimePayload.window || "24h" : uptimePayload.window || "24h"
  uptimeWindow = window
  const windowLabel = window === "1h" ? "за 1 час" : "за 24 часа"
  const at = uptimePayloadAt || Date.now()
  $("uptime-meta").textContent = `${plural(bars.length, "модель", "модели", "моделей")} · ${windowLabel} · обновлено ${new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
  const switcher = both
    ? `<div class="uptime-window" role="group" aria-label="Окно аптайма">${[["24h", "24 ч"], ["1h", "1 ч"]].map(([value, label]) => `<button type="button" data-uptime-window="${value}" class="${value === window ? "active" : ""}" aria-pressed="${value === window}">${label}</button>`).join("")}</div>`
    : ""
  body.innerHTML =
    switcher +
    (bars.length
      ? bars.map((bar) => uptimeRowHtml(bar.label, bar, uptimeBarPercent(bar, window, both), window)).join("")
      : `<div class="empty-inline">скрипт не вернул ни одной полосы</div>`)
  body.querySelectorAll("[data-uptime-window]").forEach((button) => {
    button.onclick = () => {
      uptimeWindow = button.dataset.uptimeWindow
      renderUptimeBars()
    }
  })
}

$("uptime-refresh").onclick = () => loadUptime()
$("uptime-close").onclick = () => dlgUptime.close()
dlgUptime.addEventListener("close", () => {
  uptimeProvider = null
})

// --- Uptime tab -------------------------------------------------------------
// The tab draws the cache: a block per provider with a script, then only the
// models and chains the user actually added.

let uptimeQuery = ""
const uptimeFilterProviders = new Set()
let uptimeTabWindow = "24h"
let uptimeTabGroup = "providers"
const UPTIME_FILTER_PAGE_SIZE = 10
let uptimeFilterView = "providers"
let uptimeFilterSearch = { providers: "" }
let uptimeFilterSearchOpen = { providers: false }
let uptimeFilterPage = { providers: 0 }
let uptimeFilterProviderDraft = new Set()
let uptimeFilterThreshold = null
// The slider's own position, kept while the threshold is off, so switching a
// direction back on restores the number the user last picked.
let uptimeThresholdValue = 50
let uptimeFilterDirection = "below"
const uptimeCollapsedProviders = new Set()
// The proxy's own answers, `uptimeModels`/`uptimeChains`: provider/model and
// chain -> { percent, ok, total, cells }. Loaded with the tab, refreshed with
// the log poll, so the second strip moves with real traffic.
let uptimeAnswers = { models: {}, chains: {} }

async function loadUptimeAnswers() {
  try {
    const data = await (await api("/api/uptime/answers")).json()
    if (data && typeof data === "object") uptimeAnswers = { models: {}, chains: {}, ...data }
  } catch {
    /* прокси недоступен — следующий опрос повторит */
  }
}

const uptimeModelAnswers = (provider, model) => uptimeAnswers.models?.[`${provider}/${model}`] ?? null
const uptimeChainAnswers = (name) => uptimeAnswers.chains?.[name] ?? null

const uptimeCachedBar = (provider, model) =>
  uptimeCache.get(provider)?.payload?.bars?.find((bar) => bar.label === model) ?? null

/// The number a card or row sorts and filters by: the open window's percentage.
const uptimeRowPercent = (bar, both, window) => (bar ? uptimeBarPercent(bar, window, both) : null)

/// Chains as one number. The maximum keeps a chain alive when one member is
/// down, which is what failover is for; the average is the honest picture of
/// the whole chain. The setting picks one.
function uptimeChainRows(both, window, average) {
  const rows = []
  for (const [provider, definition] of Object.entries(cfg.opencodeModels ?? {})) {
    for (const id of directModelIds(provider, definition)) {
      const bar = uptimeCachedBar(provider, id)
      rows.push({
        providers: [provider],
        label: `${provider}/${id}`,
        note: "модель",
        bar,
        percent: uptimeRowPercent(bar, both, window),
        answers: uptimeModelAnswers(provider, id),
      })
    }
  }
  for (const [name, chain] of Object.entries(cfg.models ?? {})) {
    const upstreams = chain?.upstreams ?? []
    const values = upstreams
      .map((upstream) => uptimeRowPercent(uptimeCachedBar(upstream.provider, upstream.model), both, window))
      .filter((value) => value != null)
    rows.push({
      providers: upstreams.map((upstream) => upstream.provider),
      label: name,
      note: average
        ? `цепочка · ${plural(upstreams.length, "модель", "модели", "моделей")} · среднее`
        : `цепочка · ${plural(upstreams.length, "модель", "модели", "моделей")}`,
      // A chain is an aggregate, so it has no script strip of its own.
      bar: null,
      percent: values.length
        ? average
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : Math.max(...values)
        : null,
      // The chain's own answers, not its members': failover means the chain
      // can answer while a member is down.
      answers: uptimeChainAnswers(name),
    })
  }
  return rows
}

/// The whole cache decides what the tab can offer: a switch only when every
/// script reported both windows, otherwise the single window the data names.
/// The proxy's answers always carry both windows, so the switch is offered
/// whenever there is anything to switch: the hour/day choice must drive both
/// strips, or it would silently apply to one of them.
function uptimeTabState() {
  const bars = [...uptimeCache.values()].flatMap((entry) => entry.payload?.bars ?? [])
  const scriptBoth = uptimeSharesBoth(bars)
  const onlyHour = !scriptBoth && bars.length > 0 && bars.every((bar) => bar.percent24h == null && bar.percent1h != null)
  const hasAnswers =
    Object.keys(uptimeAnswers.models ?? {}).length > 0 || Object.keys(uptimeAnswers.chains ?? {}).length > 0
  const both = scriptBoth || hasAnswers
  return { both, window: both ? uptimeTabWindow : onlyHour ? "1h" : "24h" }
}

/// A card per provider, with its models already in the order the view shows.
function uptimeProviderCards(both, window) {
  return uptimeProviders().map((provider) => {
    const entry = uptimeCache.get(provider)
    const reported = entry?.payload?.bars ?? []
    const byName = new Map(reported.map((bar) => [bar.label, bar]))
    // Provider view is the provider's whole catalog — everything it serves,
    // whether the user selected it or not — plus the models typed in by hand.
    // A model picked from an old catalog that the provider has since dropped is
    // neither: it stayed in `models` and kept a stale entry in the availability
    // map, which is why models gone for days were still listed here.
    const availability = cfg.providers[provider]?.modelAvailability ?? {}
    const selected = cfg.providers[provider]?.models ?? []
    const manual = new Set((cfg.providers[provider]?.manualModels ?? []).map(String))
    const known = [
      ...Object.entries(availability)
        .filter(([, state]) => state?.available !== false)
        .map(([id]) => id),
      ...manual,
      // Selected before the availability map existed: never checked, so there is
      // nothing saying the provider dropped them.
      ...selected.filter((id) => !(id in availability)),
    ]
    for (const model of known) {
      if (!byName.has(model) && !isImageModel(provider, model)) byName.set(model, null)
    }
    const bars = [...byName].map(([label, bar]) => ({
      bar: bar ?? { label },
      percent: uptimeRowPercent(bar, both, window),
      answers: uptimeModelAnswers(provider, label),
    })).sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))
    const values = bars.map((row) => row.percent).filter((value) => value != null)
    return {
      provider,
      entry,
      bars,
      average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    }
  })
}

/// Threshold from the filter: "ниже 75" keeps what is at or under it.
const uptimePassesThreshold = (percent) => {
  if (uptimeFilterThreshold == null) return true
  if (percent == null) return false
  return uptimeFilterDirection === "above" ? percent >= uptimeFilterThreshold : percent <= uptimeFilterThreshold
}

const uptimeMatches = (text, providers) => {
  if (uptimeFilterProviders.size && !providers.some((provider) => uptimeFilterProviders.has(provider))) return false
  const query = uptimeQuery.trim().toLowerCase()
  return !query || String(text).toLowerCase().includes(query)
}

function uptimeProviderBlock(card, both, window) {
  const { provider, entry, bars } = card
  const collapsed = uptimeCollapsedProviders.has(provider)
  const status = entry?.error
    ? `<span class="problem-rate">ошибка</span>`
    : entry
      ? `${card.average == null ? "" : `среднее ${card.average.toFixed(1)}% · `}обновлено ${uptimeTimeLabel(new Date(entry.at).toISOString())}`
      : "нет данных"
  // The widest strip of the card is the shape a bar without cells borrows.
  const grey = Array.from({ length: bars.reduce((max, row) => Math.max(max, (window === "1h" ? row.bar?.cells1h : row.bar?.cells24h)?.length ?? row.bar?.cells?.length ?? 0), 0) }, () => ({}))
  const list = entry?.error
    ? `<div class="empty-inline is-error">${esc(entry.error)}</div>`
    : bars.length
      ? bars
          .map((row) => row.percent == null
            ? `<div class="uptime-row uptime-row-empty"><div class="uptime-row-head"><span class="uptime-row-name" data-tip="${esc(row.bar.label)}">${esc(row.bar.label)}</span><span class="muted">нет данных</span></div>${uptimeStripLine(uptimeCellsHtml(grey), "Внешний")}${uptimeAnswersStripHtml(row.answers, window)}</div>`
            : uptimeRowHtml(row.bar.label, row.bar, row.percent, window, row.answers, grey))
          .join("")
      : `<div class="empty-inline">${uptimeFilterThreshold != null ? "нет моделей с аптаймом по текущему порогу" : "ожидаю первое обновление…"}</div>`
  return `<article class="card uptime-card uptime-provider-card">
    <button type="button" class="uptime-card-head" data-uptime-toggle="${esc(provider)}" aria-expanded="${!collapsed}">
      <span class="uptime-card-title"><svg class="uptime-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg><strong>${esc(provider)}</strong></span>
      <span class="uptime-card-meta">${status}</span>
    </button>
    <div class="token-bars"${collapsed ? " hidden" : ""}>${list}</div>
  </article>`
}

function renderUptimeTab() {
  const { both, window } = uptimeTabState()

  // The window switch belongs to the filter bar, so both views share it.
  const switcher = $("uptime-tab-window")
  switcher.hidden = !both
  switcher.innerHTML = both
    ? [["24h", "24 ч"], ["1h", "1 ч"]]
        .map(([value, label]) => `<button type="button" data-uptime-tab-window="${value}" class="${value === window ? "active" : ""}" aria-pressed="${value === window}">${label}</button>`)
        .join("")
    : ""
  switcher.querySelectorAll("[data-uptime-tab-window]").forEach((button) => {
    button.onclick = () => {
      uptimeTabWindow = button.dataset.uptimeTabWindow
      renderUptimeTab()
    }
  })

  // By provider: a card per scripted provider, ordered by its average uptime.
  // The threshold keeps the models that pass it and drops a card that has none,
  // so a provider with one 100% model survives "выше 80".
  const cards = uptimeProviderCards(both, window)
    .map((card) => {
      const providerMatches = uptimeMatches(card.provider, [card.provider])
      const bars = card.bars.filter((row) =>
        (providerMatches || uptimeMatches(row.bar.label, [card.provider])) &&
        (uptimeFilterThreshold == null || (row.percent != null && uptimePassesThreshold(row.percent))),
      )
      const visible = uptimeFilterThreshold == null ? providerMatches || bars.length > 0 : bars.length > 0
      return { ...card, bars, matches: visible }
    })
    .filter((card) => card.matches)
    .sort((a, b) => (b.average ?? -1) - (a.average ?? -1))
  $("uptime-providers").innerHTML = cards.length
    ? `<div class="uptime-cards">${cards.map((card) => uptimeProviderBlock(card, both, window)).join("")}</div>`
    : emptyStateHtml(uptimeProviders().length ? "ничего не найдено" : "нет провайдеров со скриптом аптайма")

  // By models: the models and chains the user actually added. A row needs one
  // of the two numbers — the script's or the proxy's own answers; a row with
  // neither would be a placeholder that pushes the real ones down.
  const average = appSettings().uptimeChainAverage === true
  const rows = uptimeChainRows(both, window, average)
    .filter((row) => (row.percent != null || row.answers?.percent != null) && uptimeMatches(row.label, row.providers))
    .filter((row) => uptimePassesThreshold(row.percent))
    .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))
  const grey = Array.from({ length: rows.reduce((max, row) => Math.max(max, (window === "1h" ? row.bar?.cells1h : row.bar?.cells24h)?.length ?? row.bar?.cells?.length ?? 0), 0) }, () => ({}))
  $("uptime-models").innerHTML = rows.length
    ? `<div class="uptime-cards"><article class="card uptime-card"><div class="token-bars">${rows
        .map((row) => `<div class="uptime-model-row">
            <div class="uptime-model-note">${esc(row.note)}</div>
            ${row.percent == null
              ? `<div class="uptime-row uptime-row-empty"><div class="uptime-row-head"><span class="uptime-row-name" data-tip="${esc(row.label)}">${esc(row.label)}</span><span class="muted">нет данных скрипта</span></div>${uptimeStripLine(uptimeCellsHtml(grey), "Внешний")}${uptimeAnswersStripHtml(row.answers, window)}</div>`
              : uptimeRowHtml(row.label, row.bar, row.percent, window, row.answers, grey)}
          </div>`)
        .join("")}</div></article></div>`
    : emptyStateHtml("нет моделей с аптаймом по текущему фильтру")

  $("uptime-search-filter").classList.toggle(
    "is-active",
    uptimeFilterProviders.size > 0 || uptimeFilterThreshold != null,
  )
}

/// Groups, search and filters all end in one redraw of the tab.
function showUptimeGroup(group) {
  uptimeTabGroup = group
  for (const button of $("uptime-groups").querySelectorAll("[data-uptime-group]")) {
    const active = button.dataset.uptimeGroup === group
    button.classList.toggle("active", active)
    button.setAttribute("aria-selected", String(active))
  }
  for (const panel of document.querySelectorAll(".uptime-panel")) {
    panel.classList.toggle("active", panel.dataset.uptimePanel === group)
  }
  renderUptimeTab()
}

function toggleUptimeProvider(provider) {
  if (uptimeCollapsedProviders.has(provider)) uptimeCollapsedProviders.delete(provider)
  else uptimeCollapsedProviders.add(provider)
  renderUptimeTab()
}

// --- Filter menu ------------------------------------------------------------
// Two tabs, like the logs filter: a paged provider list and an uptime threshold.

const uptimeFilterGroups = [["providers", "По провайдеру"], ["threshold", "Порог аптайма"]]

function uptimeFilterEntries() {
  const query = uptimeFilterSearch.providers.trim().toLowerCase()
  return uptimeProviders()
    .filter((provider) => !query || provider.toLowerCase().includes(query))
    .map((provider) => ({ value: provider, label: provider, tip: provider }))
}

function uptimeThresholdHtml() {
  const value = uptimeThresholdValue
  return `<div class="uptime-threshold">
    <div class="uptime-threshold-head"><span>Порог</span><b>${uptimeFilterThreshold == null ? "выключен" : `${uptimeFilterThreshold}%`}</b></div>
    <input class="uptime-threshold-slider" type="range" min="0" max="100" step="10" value="${value}" aria-label="Порог аптайма">
    <div class="uptime-threshold-direction" role="group" aria-label="Порог аптайма">
      <button type="button" data-uptime-direction="above" class="${uptimeFilterThreshold != null && uptimeFilterDirection === "above" ? "active" : ""}" aria-pressed="${uptimeFilterThreshold != null && uptimeFilterDirection === "above"}">выше</button>
      <button type="button" data-uptime-threshold-off class="${uptimeFilterThreshold == null ? "active" : ""}" aria-pressed="${uptimeFilterThreshold == null}">выключить</button>
      <button type="button" data-uptime-direction="below" class="${uptimeFilterThreshold != null && uptimeFilterDirection === "below" ? "active" : ""}" aria-pressed="${uptimeFilterThreshold != null && uptimeFilterDirection === "below"}">ниже</button>
    </div>
  </div>`
}

function renderUptimeFilterMenu(menu) {
  const view = uptimeFilterView
  const entries = view === "providers" ? uptimeFilterEntries() : []
  const pages = Math.max(1, Math.ceil(entries.length / UPTIME_FILTER_PAGE_SIZE))
  uptimeFilterPage.providers = Math.min(uptimeFilterPage.providers, pages - 1)
  const page = entries.slice(
    uptimeFilterPage.providers * UPTIME_FILTER_PAGE_SIZE,
    (uptimeFilterPage.providers + 1) * UPTIME_FILTER_PAGE_SIZE,
  )
  menu.className = "search-menu log-filter-menu uptime-filter-menu"
  menu.innerHTML = `<div class="log-filter-tabs">${uptimeFilterGroups
    .map(([key, label]) => `<button type="button" data-uptime-filter-view="${key}" class="${view === key ? "active" : ""}" aria-pressed="${view === key}">${label}</button>`)
    .join("")}</div>
  ${view === "providers"
    ? `<div class="log-facet-options">${
        page.length
          ? page.map((entry) => `<label class="log-facet-option" data-tip="${esc(entry.tip)}"><input type="checkbox" value="${esc(entry.value)}" ${uptimeFilterProviderDraft.has(entry.value) ? "checked" : ""}><span>${esc(entry.label)}</span></label>`).join("")
          : `<div class="empty-inline">${uptimeFilterSearch.providers.trim() ? "ничего не найдено" : "провайдеров со скриптом нет"}</div>`
      }</div>
      <div class="log-facet-footer"><button type="button" data-uptime-page="-1" aria-label="Предыдущая страница" ${uptimeFilterPage.providers === 0 ? "disabled" : ""}>‹</button><button type="button" data-uptime-filter-search aria-label="${uptimeFilterSearchOpen.providers ? "Скрыть поиск" : "Показать поиск"}" data-tip="Поиск" aria-pressed="${uptimeFilterSearchOpen.providers}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg></button><button type="button" data-uptime-page="1" aria-label="Следующая страница" ${uptimeFilterPage.providers >= pages - 1 ? "disabled" : ""}>›</button></div>
      ${uptimeFilterSearchOpen.providers ? `<input class="log-facet-search" type="search" aria-label="Поиск провайдера" placeholder="Провайдер" value="${esc(uptimeFilterSearch.providers)}" autocomplete="off">` : ""}`
    : uptimeThresholdHtml()}`

  menu.querySelectorAll("[data-uptime-filter-view]").forEach((button) => {
    button.onclick = () => {
      uptimeFilterView = button.dataset.uptimeFilterView
      refreshUptimeFilterMenu()
    }
  })
  menu.querySelectorAll(".log-facet-option input").forEach((input) => {
    input.onchange = () => {
      if (input.checked) uptimeFilterProviderDraft.add(input.value)
      else uptimeFilterProviderDraft.delete(input.value)
      uptimeFilterProviders.clear()
      for (const provider of uptimeFilterProviderDraft) uptimeFilterProviders.add(provider)
      renderUptimeTab()
    }
  })
  menu.querySelectorAll("[data-uptime-page]").forEach((button) => {
    button.onclick = () => {
      uptimeFilterPage.providers += Number(button.dataset.uptimePage)
      refreshUptimeFilterMenu()
    }
  })
  menu.querySelector("[data-uptime-filter-search]")?.addEventListener("click", () => {
    uptimeFilterSearchOpen.providers = !uptimeFilterSearchOpen.providers
    if (!uptimeFilterSearchOpen.providers) uptimeFilterSearch.providers = ""
    uptimeFilterPage.providers = 0
    refreshUptimeFilterMenu()
    if (uptimeFilterSearchOpen.providers) menu.querySelector(".log-facet-search")?.focus()
  })
  menu.querySelector(".log-facet-search")?.addEventListener("input", (event) => {
    uptimeFilterSearch.providers = event.target.value
    uptimeFilterPage.providers = 0
    refreshUptimeFilterMenu()
    const input = menu.querySelector(".log-facet-search")
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  })
  // The slider picks the number while the user drags it; the list is redrawn
  // only when the pointer is released (`change`), so dragging through other
  // values does not rebuild the tab on every pixel.
  const slider = menu.querySelector(".uptime-threshold-slider")
  const showSliderValue = () => {
    const head = menu.querySelector(".uptime-threshold-head b")
    if (head) head.textContent = `${uptimeThresholdValue}%`
  }
  slider?.addEventListener("input", (event) => {
    uptimeThresholdValue = Number(event.target.value)
    showSliderValue()
  })
  slider?.addEventListener("change", (event) => {
    uptimeThresholdValue = Number(event.target.value)
    uptimeFilterThreshold = uptimeThresholdValue
    showSliderValue()
    menu.querySelectorAll("[data-uptime-direction]").forEach((button) => {
      const active = button.dataset.uptimeDirection === uptimeFilterDirection
      button.classList.toggle("active", active)
      button.setAttribute("aria-pressed", String(active))
    })
    const off = menu.querySelector("[data-uptime-threshold-off]")
    off?.classList.remove("active")
    off?.setAttribute("aria-pressed", "false")
    renderUptimeTab()
  })
  menu.querySelectorAll("[data-uptime-threshold-off]").forEach((button) => {
    button.onclick = () => {
      uptimeFilterThreshold = null
      refreshUptimeFilterMenu()
      renderUptimeTab()
    }
  })
  menu.querySelectorAll("[data-uptime-direction]").forEach((button) => {
    button.onclick = () => {
      uptimeFilterDirection = button.dataset.uptimeDirection
      // A direction with no threshold would leave the switch dead, so restore
      // the last slider value when the user enables filtering again.
      if (uptimeFilterThreshold == null) uptimeFilterThreshold = uptimeThresholdValue
      refreshUptimeFilterMenu()
      renderUptimeTab()
    }
  })
}

function refreshUptimeFilterMenu() {
  renderUptimeFilterMenu(searchMenu)
  if (searchMenuAnchor) positionSearchMenu(searchMenuAnchor)
}

$("uptime-groups").querySelectorAll("[data-uptime-group]").forEach((button) => {
  button.onclick = () => showUptimeGroup(button.dataset.uptimeGroup)
})
$("uptime-search").oninput = (event) => {
  uptimeQuery = event.target.value
  renderUptimeTab()
}
$("uptime-search-clear").onclick = () => {
  uptimeQuery = ""
  $("uptime-search").value = ""
  uptimeFilterProviders.clear()
  uptimeFilterProviderDraft.clear()
  uptimeFilterThreshold = null
  uptimeFilterSearch.providers = ""
  closeSearchMenu()
  renderUptimeTab()
  $("uptime-search").focus()
}
$("uptime-search-filter").onclick = () => {
  uptimeFilterProviderDraft = new Set(uptimeFilterProviders)
  openSearchMenuContent($("uptime-search-filter"), renderUptimeFilterMenu, () => {
    uptimeFilterSearchOpen.providers = false
    uptimeFilterSearch.providers = ""
  })
}
// The card head is a button: one click folds the provider's models away.
$("uptime-providers").addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-uptime-toggle]")
  if (toggle) toggleUptimeProvider(toggle.dataset.uptimeToggle)
})

/// Manual refresh: re-read the model catalogs, re-run the uptime scripts and
/// re-read today's answers. The catalog refresh is what drops models a provider
/// no longer serves — without it the tab kept showing the same stale list.
$("uptime-tab-refresh").onclick = async () => {
  const button = $("uptime-tab-refresh")
  if (uptimeRoundRunning) return
  button.disabled = true
  button.classList.add("is-spinning")
  try {
    for (const provider of uptimeProviders()) {
      try {
        await refreshProviderCatalog(provider)
      } catch {
        /* одному провайдеру не обновиться — остальные всё равно обновятся */
      }
    }
    renderUptimeTab()
    await Promise.all([refreshAllUptime(), loadUptimeAnswers()])
    renderUptimeTab()
  } finally {
    button.disabled = false
    button.classList.remove("is-spinning")
  }
}

/// Called when the tab opens: draw what is cached, and fetch once if nothing is.
/// The proxy also gets the cached uptime here, so its chain ranking has the
/// same numbers after a GUI reload as it had before.
/// The catalog is re-read once per session so the provider list is what the
/// provider serves today, not what it served when the app was last opened. The
/// scripts run after it, because they parse the catalog the proxy hands them.
function refreshUptimeTab() {
  loadUptimeAnswers().then(renderUptimeTab)
  renderUptimeTab()
  pushUptimeBars()
  const providers = uptimeProviders()
  // Not loaded yet (the tab draws once before boot finishes): try again later.
  if (uptimeCatalogLoaded || !providers.length) {
    if (!uptimeCache.size) refreshAllUptime()
    return
  }
  uptimeCatalogLoaded = true
  Promise.all(providers.map((provider) => refreshProviderCatalog(provider).catch(() => false)))
    .then(() => {
      renderUptimeTab()
      if (!uptimeCache.size) refreshAllUptime()
    })
}

renderUptimeTab()
if (tab === "uptime") refreshUptimeTab()

// Today's answers move with traffic, so the second strip is re-read while the
// tab is open; a hidden window polls nothing.
setInterval(() => {
  if (document.hidden || tab !== "uptime") return
  loadUptimeAnswers().then(renderUptimeTab)
}, 10 * 1000)

// --- Auto refresh -----------------------------------------------------------
// Ticks often, starts a round only when the interval passed. A round still in
// flight skips the tick instead of stacking a second queue, so even one minute
// in the settings cannot pile runs up. A hidden window does not fetch at all.
setInterval(() => {
  if (document.hidden || uptimeRoundRunning) return
  const minutes = Number(appSettings().uptimeRefreshMinutes ?? 10)
  if (!(minutes > 0)) return
  if (Date.now() - uptimeLastRoundAt < Math.max(1, minutes) * 60 * 1000) return
  refreshAllUptime()
}, 30 * 1000)
