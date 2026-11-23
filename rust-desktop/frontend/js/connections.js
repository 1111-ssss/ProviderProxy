let pmState = { provider: null, ids: [], filter: "", loading: false, error: null }
// Active model filters. Empty means "show everything"; every checkbox is
// independent, so the user can pick any combination.
let pmFilters = new Set()
function pmFilterActive() { return pmFilters.size > 0 }
function syncPmFilterButton() {
  const button = $("pm-filter-menu")
  if (!button) return
  button.classList.toggle("is-active", pmFilterActive())
  button.dataset.tip = pmFilterActive() ? "Фильтр моделей (включён)" : "Фильтр моделей"
}
function togglePmFilter(value) {
  if (pmFilters.has(value)) pmFilters.delete(value)
  else pmFilters.add(value)
  syncPmFilterButton()
  renderPmList()
}

function pmCurrentLine() {
  const name = pmState.provider ?? "—"
  const status = pmState.loading
    ? "загружаю список моделей..."
    : pmState.error
      ? "не удалось загрузить список моделей, показаны сохранённые"
      : ""
  $("pm-provider-current").innerHTML = `<strong>${esc(name)}</strong>${status ? `<span class="pm-current-status${pmState.error ? " is-error" : ""}"> — ${esc(status)}</span>` : ""}`
}

function renderProviderModels() {
  const allNames = Object.keys(cfg.providers)
  const query = pmProviderFilter.trim().toLowerCase()
  const names = query ? allNames.filter((name) => name.toLowerCase().includes(query)) : allNames
  if (!allNames.length) {
    pmState = { provider: null, ids: [], filter: "", loading: false, error: null }
    pmCurrentLine()
    $("pm-provider-options").innerHTML = emptyStateHtml("провайдеров пока нет — добавь на вкладке «Провайдеры»")
    $("pm-list").innerHTML = ""
    return
  }
  if (!allNames.includes(pmState.provider))
    pmState = { provider: allNames[0], ids: [...(cfg.providers[allNames[0]].models ?? [])], filter: "", loading: false, error: null }
  pmCurrentLine()
  $("pm-provider-options").innerHTML = names.length
    ? providerOptionsHtml(names, pmState.provider)
    : emptyStateHtml("ничего не найдено")
  $("pm-provider-options").querySelectorAll("[data-provider]").forEach((button) => {
    button.onclick = () => {
      const name = button.dataset.provider
      pmState = { provider: name, ids: [...(cfg.providers[name].models ?? [])], filter: "", loading: false, error: null }
      pmProviderFilter = ""
      $("pm-provider-filter").value = ""
      renderProviderModels()
      loadPmModels(name)
    }
  })
  $("pm-filter").value = pmState.filter
  renderPmList()
}

// "Выбирать все автоматически": every start re-reads /v1/models and keeps the
// whole list selected — new models appear, models the provider no longer serves
// leave (unless typed in by hand). The per-model checkboxes stay as the user
// left them: the flag is what selects everything, not a wall of ticks. The
// Models tab entry for this provider follows the same list, so opening it shows
// every model the provider has.
const providerAutoAll = () => (cfg.providerAutoAll ??= {})
const isAutoAllProvider = (name) => providerAutoAll()[name] === true
async function syncAutoAllProvider(name, { refreshOnly = false } = {}) {
  const provider = cfg.providers[name]
  if (!provider) return
  const res = await fetchProviderModels(name)
  if (res.error) return
  const returned = new Set(res.ids)
  const manual = new Set((provider.manualModels ?? []).map(String))
  // Selecting every returned model is the point of the bookmark, but on the
  // first paint the user has chosen nothing yet: refreshOnly just records what
  // the provider serves and leaves `models` alone.
  if (refreshOnly) {
    provider.modelAvailability ??= {}
    const at = new Date().toISOString()
    for (const id of res.ids) provider.modelAvailability[id] = { available: true, checkedAt: at }
    mergeProviderModelDetails(provider, res.details)
    pmState.ids = [...new Set([...(provider.models ?? []), ...res.ids])]
    cleanupModelMetadata()
    return
  }
  provider.models = [...new Set([...res.ids, ...manual])]
  provider.modelAvailability ??= {}
  const at = new Date().toISOString()
  for (const id of res.ids) provider.modelAvailability[id] = { available: true, checkedAt: at }
  for (const id of manual) provider.modelAvailability[id] ??= { available: returned.has(id), checkedAt: at }
  mergeProviderModelDetails(provider, res.details)
  // The Models tab reads `all`, so keep that entry pointing at the fresh list.
  const direct = (cfg.opencodeModels ??= {})[name] ??= {}
  direct.all = true
  direct.models = [...provider.models]
  cleanupModelMetadata()
  const chainsChanged = removeImageModelsFromChains()
  save()
  if (chainsChanged) renderModels()
  renderOpencodeModels()
  renderOpenCode()
}
async function syncAutoAllProviders({ refreshOnly = false } = {}) {
  for (const name of Object.keys(cfg.providers ?? {})) {
    if (!isAutoAllProvider(name)) continue
    try {
      await syncAutoAllProvider(name, { refreshOnly })
    } catch {
      /* один провайдер не должен ломать запуск остальных */
    }
  }
}

async function loadPmModels(name) {
  if (!cfg.providers[name]) return
  pmState.loading = true
  pmState.error = null
  renderProviderModels()
  const res = await fetchProviderModels(name)
  if (pmState.provider !== name) return // пока грузилось, выбрали другого провайдера
  pmState.loading = false
  pmState.error = res.error ?? null
  if (!res.error) {
    const provider = cfg.providers[name]
    const ids = [...new Set([...(provider.models ?? []), ...res.ids])]
    const returned = new Set(res.ids)
    const availability = (provider.modelAvailability ??= {})
    for (const id of ids) availability[id] = { available: returned.has(id), checkedAt: new Date().toISOString() }
    mergeProviderModelDetails(provider, res.details)
    pmState.ids = ids
    cleanupModelMetadata()
    const chainsChanged = removeImageModelsFromChains()
    save()
    if (chainsChanged) {
      renderModels()
      renderOpenCode()
    }
  }
  renderProviderModels()
  renderImageGenerator()
}

$("pm-provider-filter").oninput = (e) => {
  pmProviderFilter = e.target.value
  renderProviderModels()
  const input = $("pm-provider-filter")
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}
$("pm-provider-filter-clear").onclick = () => {
  pmProviderFilter = ""
  $("pm-provider-filter").value = ""
  renderProviderModels()
  $("pm-provider-filter").focus()
}

$("pm-refresh").onclick = () => loadPmModels(pmState.provider)

async function setPmAutoAll(enabled) {
  const name = pmState.provider
  if (!name) return
  const map = providerAutoAll()
  if (enabled) {
    // Remember the manual selection so switching auto off brings the ticks back
    // exactly as they were; the sync below only replaces the effective list.
    cfg.providers[name].autoSelectedModels ??= [...(cfg.providers[name].models ?? [])]
    map[name] = true
    save()
    await syncAutoAllProvider(name)
    flash(true, `«${esc(name)}»: все модели выбираются автоматически`)
  } else {
    // Turning it off freezes the list exactly as the user has it now.
    delete map[name]
    const provider = cfg.providers[name]
    if (Array.isArray(provider.autoSelectedModels)) provider.models = [...provider.autoSelectedModels]
    delete provider.autoSelectedModels
    const direct = cfg.opencodeModels?.[name]
    if (direct?.all === true) {
      direct.all = false
      direct.models = [...(provider.models ?? [])]
    }
    save()
    flash(true, `«${esc(name)}»: автовыбор выключен, список остаётся текущим`)
  }
  renderProviderModels()
  renderModels()
  renderOpencodeModels()
  renderOpenCode()
  renderImageGenerator()
}

function pmBulkSelect(selected) {
  const name = pmState.provider
  if (!name) return flash(false, "сначала выбери провайдера")
  const provider = cfg.providers[name]
  const chainsBefore = chainFillSnapshot()
  if (selected) {
    provider.models = [...new Set([...(provider.models ?? []), ...pmState.ids])]
  } else {
    // Snapshot: removeModelReferences mutates provider.models via direct lists.
    for (const id of [...(provider.models ?? [])]) removeModelReferences(name, id)
    provider.models = []
    pmState.ids = pmState.ids.filter((id) => provider.modelAvailability?.[id]?.available === true)
  }
  // "Select all" keeps the manual ticks in sync when auto manages the list.
  if (isAutoAllProvider(name) && selected) provider.autoSelectedModels = [...(provider.models ?? [])]
  save()
  renderProviderModels()
  renderProviders()
  renderModels()
  renderOpencodeModels()
  renderOpenCode()
  renderImageGenerator()
  reportEmptiedChains(chainsBefore)
}

$("pm-menu").onclick = () => {
  const auto = pmState.provider ? isAutoAllProvider(pmState.provider) : false
  openSearchMenu($("pm-menu"), [
    { label: "Выбрать все", action: () => pmBulkSelect(true) },
    { label: "Отключить все", action: () => pmBulkSelect(false) },
    { label: "Выбирать все автоматически", toggle: true, checked: auto, action: (on) => setPmAutoAll(on) },
  ])
}
$("pm-filter-menu").onclick = () => {
  openSearchMenu($("pm-filter-menu"), [
    { label: "Выбранные", toggle: true, stayOpen: true, checked: pmFilters.has("selected"), action: () => togglePmFilter("selected") },
    { label: "Не выбранные", toggle: true, stayOpen: true, checked: pmFilters.has("unselected"), action: () => togglePmFilter("unselected") },
    { label: "Чат", toggle: true, stayOpen: true, checked: pmFilters.has("chat"), action: () => togglePmFilter("chat") },
    { label: "Изображения", toggle: true, stayOpen: true, checked: pmFilters.has("image"), action: () => togglePmFilter("image") },
  ])
}
$("pm-filter").oninput = (e) => {
  pmState.filter = e.target.value
  renderPmList()
  const nf = $("pm-filter")
  nf.focus()
  nf.setSelectionRange(nf.value.length, nf.value.length)
}
$("pm-filter-clear").onclick = () => {
  pmState.filter = ""
  $("pm-filter").value = ""
  pmFilters.clear()
  syncPmFilterButton()
  renderPmList()
  $("pm-filter").focus()
}
$("pm-add").onclick = () => {
  if (!pmState.provider) return flash(false, "сначала добавь провайдера")
  const id = $("pm-manual").value.trim()
  if (!id) return flash(false, "впиши ID модели")
  const provider = cfg.providers[pmState.provider]
  const arr = (provider.models ??= [])
  if (arr.includes(id)) return flash(false, "уже есть")
  arr.push(id)
  // A typed-in model must survive the "/v1/models" refresh, which otherwise
  // treats anything missing from the response as removed.
  ;(provider.manualModels ??= []).push(id)
  if (!pmState.ids.includes(id)) pmState.ids.unshift(id)
  $("pm-manual").value = ""
  save()
  renderProviderModels()
  renderImageGenerator()
}

function removeModelFromChains(provider, id) {
  let changed = false
  for (const def of Object.values(cfg.models ?? {})) {
    const before = def.upstreams?.length ?? 0
    def.upstreams = (def.upstreams ?? []).filter((upstream) => !(upstream.provider === provider && upstream.model === id))
    changed ||= def.upstreams.length !== before
  }
  return changed
}

/// Chains that just lost their last upstream. Reported once per edit so the
/// user hears about an emptied chain, not on every model toggle.
function emptiedChainNames(chainStates) {
  const names = []
  for (const [name, wasFilled] of chainStates) {
    if (wasFilled && (cfg.models?.[name]?.upstreams?.length ?? 0) === 0) names.push(name)
  }
  return names
}

function chainFillSnapshot() {
  const snapshot = new Map()
  for (const [name, def] of Object.entries(cfg.models ?? {})) snapshot.set(name, (def.upstreams?.length ?? 0) > 0)
  return snapshot
}

/// Shows one toast naming the chains that became empty because of this edit.
function reportEmptiedChains(snapshot) {
  const names = emptiedChainNames(snapshot)
  if (!names.length) return
  const label = names.map((name) => `«${name}»`).join(", ")
  flash(false, names.length === 1 ? `цепочка ${label} теперь пуста` : `цепочки ${label} теперь пусты`)
}

function removeModelReferences(provider, id) {
  let changed = removeModelFromChains(provider, id)
  const direct = cfg.opencodeModels?.[provider]
  if (direct) {
    const models = Array.isArray(direct.models) ? direct.models : []
    const next = direct.all === true ? directModelIds(provider, direct) : models.filter((model) => model !== id)
    if (next.length !== models.length) changed = true
    if (next.length) direct.models = next
    else {
      delete cfg.opencodeModels[provider]
      changed = true
    }
  }
  const settings = cfg.imageSettings
  if (settings?.defaultProvider === provider && settings.defaultModel === id) {
    settings.defaultModel = ""
    changed = true
  }
  if (Array.isArray(settings?.skillModels?.[provider])) {
    const next = settings.skillModels[provider].filter((model) => model !== id)
    if (next.length !== settings.skillModels[provider].length) changed = true
    if (next.length) settings.skillModels[provider] = next
    else delete settings.skillModels[provider]
  }
  return changed
}

function removeProviderReferences(provider) {
  delete cfg.opencodeModels?.[provider]
  for (const m of Object.values(cfg.models ?? {})) m.upstreams = (m.upstreams ?? []).filter((u) => u.provider !== provider)
  const settings = cfg.imageSettings
  if (settings?.defaultProvider === provider) {
    settings.defaultProvider = ""
    settings.defaultModel = ""
  }
  if (settings?.skillModels) delete settings.skillModels[provider]
}

function removeImageModelsFromChains() {
  let changed = false
  for (const def of Object.values(cfg.models ?? {})) {
    const before = def.upstreams?.length ?? 0
    def.upstreams = (def.upstreams ?? []).filter((upstream) => !isImageModel(upstream.provider, upstream.model))
    changed ||= def.upstreams.length !== before
  }
  return changed
}

function renderPmList() {
  const p = pmState.provider ? cfg.providers[pmState.provider] : null
  if (!p) return ($("pm-list").innerHTML = "")
  const auto = isAutoAllProvider(pmState.provider)
  // Ticks show the user's own selection. The auto flag manages the effective
  // list in the background and must not move them.
  const saved = auto ? (p.autoSelectedModels ?? p.models ?? []) : (p.models ?? [])
  const ft = (pmState.filter ?? "").toLowerCase()
  const shown = pmState.ids.filter((id) => {
    if (!id.toLowerCase().includes(ft)) return false
    // Picking both boxes of a pair means "either", i.e. no restriction.
    if (pmFilters.has("image") && !pmFilters.has("chat") && !isImageModel(pmState.provider, id)) return false
    if (pmFilters.has("chat") && !pmFilters.has("image") && isImageModel(pmState.provider, id)) return false
    if (pmFilters.has("selected") && !pmFilters.has("unselected") && !saved.includes(id)) return false
    if (pmFilters.has("unselected") && !pmFilters.has("selected") && saved.includes(id)) return false
    return true
  })
  // Model filters live in the panel button; keep its state in sync on every list render.
  syncPmFilterButton()
  $("pm-list").innerHTML = shown.length
    ? modelCardsHtml(pmState.provider, shown, { checked: (id) => saved.includes(id), disabled: auto, settings: true })
    : emptyStateHtml(pmState.ids.length ? "ничего не найдено" : "список пуст — обнови его или добавь модель вручную")
  // No redraw per click — only counters, otherwise the list scroll jumps to the top.
  $("pm-list").querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => {
      const arr = (cfg.providers[pmState.provider].models ??= [])
      const i = arr.indexOf(cb.dataset.id)
      if (cb.checked && i < 0) arr.push(cb.dataset.id)
      const chainsBefore = chainFillSnapshot()
      if (!cb.checked && i >= 0) {
        arr.splice(i, 1)
        removeModelReferences(pmState.provider, cb.dataset.id)
        if (cfg.providers[pmState.provider].modelAvailability?.[cb.dataset.id]?.available !== true)
          pmState.ids = pmState.ids.filter((id) => id !== cb.dataset.id)
      }
      save()
      renderProviders() // счётчик моделей в таблице провайдеров
      renderModels()
      renderOpencodeModels()
      renderOpenCode()
      renderImageGenerator()
      reportEmptiedChains(chainsBefore)
    }
  })
  $("pm-list").querySelectorAll("button[data-model-settings]").forEach((button) => {
    button.onclick = () => openModelSettings(pmState.provider, button.dataset.modelSettings)
  })
  applyPmColumns($("pm-list"))
}

// Cards per row: as many as fit without clipping a card's content. The probe
// measures each card's full natural width (id + badges); if even one card would
// be squeezed, the column count drops until it fits.
function pmColumnCount(available, cardWidth, gap = 8) {
  return Math.max(1, Math.min(4, Math.floor((available + gap) / (cardWidth + gap))))
}
let pmColumnsObserver = null
function applyPmColumns(box) {
  // Measured once per render: a max-content copy reports the width the card
  // wants, badges and all. One pathologically long id must not collapse the
  // grid to a single column, hence the cap.
  const MAX_CARD = 320
  const probe = document.createElement("div")
  probe.className = "provider-model-card"
  probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;width:max-content"
  document.body.append(probe)
  let widest = 0
  for (const card of box.querySelectorAll(".provider-model-card")) {
    probe.replaceChildren(...[...card.childNodes].map((node) => node.cloneNode(true)))
    widest = Math.max(widest, Math.ceil(probe.getBoundingClientRect().width))
  }
  probe.remove()
  // The card cannot shrink below its fixed chrome (tick, gap, ⋮ button), so a
  // very long id is capped rather than forcing one column.
  const MIN_CARD = 210
  const needed = Math.max(MIN_CARD, Math.min(MAX_CARD, widest))
  const grid = box.querySelector(".pm-grid") ?? box
  const fit = () => {
    const available = grid.clientWidth
    if (!available) return // hidden tab: the observer fires once it has width
    const cols = pmColumnCount(available, needed)
    if (grid.dataset.pmCols === String(cols)) return
    grid.dataset.pmCols = String(cols)
    grid.style.setProperty("--pm-cols", cols)
  }
  fit()
  pmColumnsObserver?.disconnect()
  pmColumnsObserver = new ResizeObserver(() => requestAnimationFrame(fit))
  pmColumnsObserver.observe(grid)
}
