// ---------- блок: модели провайдеров (галочки) ----------

let pmState = { provider: null, ids: [], filter: "", loading: false, error: null }

function renderProviderModels() {
  const allNames = Object.keys(cfg.providers)
  const query = pmProviderFilter.trim().toLowerCase()
  const names = query ? allNames.filter((name) => name.toLowerCase().includes(query)) : allNames
  if (!allNames.length) {
    pmState = { provider: null, ids: [], filter: "", loading: false, error: null }
    $("pm-provider").innerHTML = ""
    $("pm-provider").disabled = true
    $("pm-provider-current").innerHTML = "<strong>—</strong>"
    $("pm-provider-result").textContent = ""
    $("pm-status").textContent = ""
    $("pm-provider-options").innerHTML = `<span class="muted">провайдеров пока нет — добавь в шаге 1</span>`
    $("pm-list").innerHTML = ""
    return
  }
  if (!allNames.includes(pmState.provider))
    pmState = { provider: allNames[0], ids: [...(cfg.providers[allNames[0]].models ?? [])], filter: "", loading: false, error: null }
  $("pm-provider").disabled = false
  $("pm-provider").innerHTML = allNames.map((name) => `<option ${name === pmState.provider ? "selected" : ""}>${esc(name)}</option>`).join("")
  $("pm-provider-current").innerHTML = `<strong>${esc(pmState.provider)}</strong>`
  $("pm-provider-result").textContent = query ? `${names.length} из ${allNames.length}` : `${allNames.length} ${allNames.length === 1 ? "провайдер" : "провайдеров"}`
  $("pm-provider-options").innerHTML = names.length
    ? names
        .map(
          (name) => `<button type="button" class="provider-option ${name === pmState.provider ? "active" : ""}" data-provider="${esc(name)}" role="option" aria-selected="${name === pmState.provider}">
            <strong>${esc(name)}</strong><small>${plural((cfg.providers[name].models ?? []).length, "модель", "модели", "моделей")}</small>
          </button>`,
        )
        .join("")
    : `<span class="muted">провайдер не найден — измени запрос</span>`
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
  $("pm-autoload").checked = isAutoAllProvider(pmState.provider)
  const saved = cfg.providers[pmState.provider].models ?? []
  $("pm-status").textContent = pmState.loading
    ? "загружаю /v1/models…"
    : pmState.error
      ? `не удалось загрузить (${pmState.error}) — показаны сохранённые`
      : isAutoAllProvider(pmState.provider)
        ? `все модели провайдера выбираются автоматически (${pmState.ids.length})`
        : `выбрано ${saved.length} из ${pmState.ids.length}`
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
async function syncAutoAllProvider(name) {
  const provider = cfg.providers[name]
  if (!provider) return
  const res = await fetchProviderModels(name)
  if (res.error) return
  const returned = new Set(res.ids)
  const manual = new Set((provider.manualModels ?? []).map(String))
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
async function syncAutoAllProviders() {
  for (const name of Object.keys(cfg.providers ?? {})) {
    if (!isAutoAllProvider(name)) continue
    try {
      await syncAutoAllProvider(name)
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

$("pm-provider").onchange = (e) => {
  pmState = { provider: e.target.value, ids: [...(cfg.providers[e.target.value]?.models ?? [])], filter: "", loading: false, error: null }
  renderProviderModels()
  loadPmModels(pmState.provider)
}
$("pm-refresh").onclick = () => loadPmModels(pmState.provider)
$("pm-autoload").onchange = async (e) => {
  const name = pmState.provider
  if (!name) return
  const map = providerAutoAll()
  if (e.target.checked) {
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
$("pm-filter").oninput = (e) => {
  pmState.filter = e.target.value
  renderPmList()
  const nf = $("pm-filter")
  nf.focus()
  nf.setSelectionRange(nf.value.length, nf.value.length)
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
  const shown = pmState.ids.filter((id) => id.toLowerCase().includes(ft))
  $("pm-list").innerHTML = shown.length
    ? shown
        .map(
           (id) => `
        <div class="provider-model-card">
          <label class="provider-model-card-main">
            <input type="checkbox" data-id="${esc(id)}" ${saved.includes(id) ? "checked" : ""}${auto ? " disabled" : ""}>
            <span class="provider-model-card-body">
              <code>${esc(id)}</code>
              <span class="provider-model-card-meta">${isImageModel(pmState.provider, id) ? imageIcon() : ""}${contextBadge(pmState.provider, id)}${availabilityBadge(pmState.provider, id)}</span>
            </span>
          </label>
          <button type="button" class="model-settings-button" data-model-settings="${esc(id)}" aria-label="Параметры модели ${esc(id)}" title="Параметры модели">⋮</button>
        </div>`,
        )
        .join("")
    : `<span class="muted">${pmState.ids.length ? "ничего не найдено" : "список пуст — нажми «обновить список» или добавь вручную"}</span>`
  // перерисовки на каждый клик нет — только счётчики, иначе скролл списка прыгает наверх
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
      $("pm-status").textContent = `выбрано ${arr.length} из ${pmState.ids.length}`
      reportEmptiedChains(chainsBefore)
    }
  })
  $("pm-list").querySelectorAll("button[data-model-settings]").forEach((button) => {
    button.onclick = () => openModelSettings(pmState.provider, button.dataset.modelSettings)
  })
  applyPmColumns($("pm-list"))
}

// Cards per row: as many as the widest model id still fits on one line, capped
// at three. A column of full names beats three columns of cut ones.
let pmColumnsObserver = null
function applyPmColumns(box) {
  const CHROME = 92 // checkbox, gaps, ⋮ and card padding
  const gap = 6
  const widestId = () => {
    let widest = 0
    for (const el of box.querySelectorAll(".provider-model-card-body code")) {
      el.style.whiteSpace = "nowrap"
      widest = Math.max(widest, el.getBoundingClientRect().width)
      el.style.whiteSpace = ""
    }
    return widest
  }
  const fit = () => {
    const available = box.clientWidth
    if (!available) return // hidden tab: the observer fires once it has width
    const needed = (widestId() || 210) + CHROME
    const cols = Math.max(1, Math.min(4, Math.floor((available + gap) / (needed + gap))))
    if (box.dataset.pmCols === String(cols)) return
    box.dataset.pmCols = String(cols)
    box.style.setProperty("--pm-cols", cols)
  }
  fit()
  pmColumnsObserver?.disconnect()
  pmColumnsObserver = new ResizeObserver(() => requestAnimationFrame(fit))
  pmColumnsObserver.observe(box)
}

