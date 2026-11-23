// Deleting a provider lives in its edit dialog: a permanent trash button in the
// table put a destructive action one stray click away.
async function deleteProvider(name) {
  if (!(await askConfirm(`Удалить провайдера «${name}»? Его записи уберутся из цепочек моделей.`, { title: "Удалить провайдера", okLabel: "Удалить", danger: true }))) return false
  const chainsBefore = chainFillSnapshot()
  delete cfg.providers[name]
  removeProviderReferences(name)
  save(); renderAll()
  reportEmptiedChains(chainsBefore)
  return true
}

function renderProviders() {
  const t = $("providers")
  const allEntries = Object.entries(cfg.providers)
  const query = providersFilter.trim().toLowerCase()
  const shown = query
    ? allEntries.filter(([name, p]) => `${name} ${p.baseURL ?? ""}`.toLowerCase().includes(query))
    : allEntries
  t.innerHTML = shown.length ? "<tr><th>имя</th><th>baseURL</th><th>модели</th><th></th></tr>" : ""
  let anyCheckin = false
  for (const [name, p] of shown) {
    const models = p.models ?? []
    if (p.checkin) anyCheckin = true
    const tr = t.insertRow()
    tr.innerHTML = `
      <td><b>${esc(name)}</b>${p.homepage || p.checkin ? `<span class="provider-links">${p.homepage ? `<button type="button" class="icon-action" data-a="homepage" data-tip="Открыть страницу провайдера" aria-label="Открыть страницу провайдера"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg></button>` : ""}${p.checkin ? `<button type="button" class="icon-action" data-a="checkin" data-tip="Открыть чекин" aria-label="Открыть чекин"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12v9H4v-9"></path><path d="M2 7h20v5H2z"></path><path d="M12 22V7"></path><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg></button>` : ""}</span>` : ""}</td>
      <td class="muted">${esc(p.baseURL ?? "")}</td>
      <td class="muted">${models.length}</td>
      <td class="provider-actions">
        <button type="button" class="icon-action" data-a="edit" data-tip="Изменить" aria-label="Изменить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
      </td>`
    if (p.homepage) tr.querySelector('[data-a="homepage"]').onclick = () => openUrl(p.homepage)
    if (p.checkin) tr.querySelector('[data-a="checkin"]').onclick = () => openUrl(p.checkin)
    tr.querySelector('[data-a="edit"]').onclick = () => openProviderDialog(name)
  }
  $("p-checkins").style.display = anyCheckin ? "" : "none"
  if (!shown.length) {
    $("providers-empty").innerHTML = emptyStateHtml(allEntries.length ? "ничего не найдено" : "провайдеров пока нет — нажми «Добавить»")
  } else {
    $("providers-empty").innerHTML = ""
  }
}

$("p-checkins").onclick = () => {
  for (const p of Object.values(cfg.providers)) if (p.checkin) openUrl(p.checkin)
}

function renderModels() {
  const box = $("models")
  box.innerHTML = ""
  syncFilterButton("m-search-filter", chainFilters)
  const query = modelSearch.trim().toLowerCase()
  const allEntries = Object.entries(cfg.models)
  const entries = allEntries
    .filter(([name]) => !query || name.toLowerCase().includes(query))
    .filter(([, def]) => {
      if (!chainFilters.size) return true
      return [...chainFilters].some((kind) =>
        kind === "active" ? def?.enabled !== false
        : kind === "disabled" ? def?.enabled === false
        : !(def?.upstreams ?? []).length)
    })
    .sort(([, a], [, b]) => Number(a?.enabled === false) - Number(b?.enabled === false))
  for (const [name, def] of entries) {
    const ups = def.upstreams ?? []
    const enabled = def.enabled !== false
     const div = document.createElement("div")
     div.className = `card${enabled ? "" : " chain-disabled"}`
     div.dataset.model = name
    div.innerHTML = `
    <div class="model-card-head">
        <b class="model-title">${esc(name)}</b>
        <div class="model-badges">
          ${ups.length ? "" : `<span class="pill empty">пусто</span>`}${chainContextBadge(ups)}
        </div>
        <div class="head-controls">
          <label class="chain-toggle ${enabled ? "is-on" : "is-off"}" data-tip="${enabled ? "Убрать цепочку из публикации" : "Вернуть цепочку в публикацию"}" aria-label="${enabled ? "Активна" : "Скрыта"}">
            <input type="checkbox" data-a="toggle" ${enabled ? "checked" : ""}>
            <span class="chain-switch" aria-hidden="true"></span>
          </label>
          <div class="model-actions">
            <button type="button" class="icon-action" data-a="edit" data-tip="Изменить" aria-label="Изменить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
          </div>
        </div>
      </div>
      <div class="chain">
        ${ups.length
          ? ups
              .map(
                (u, i) => `
                <div class="step">
                  <span class="n">${i + 1}.</span><span class="opencode-model chain-model"><strong>${esc(u.model ?? "")}</strong></span>${u.provider && !cfg.providers[u.provider] ? `<span class="muted">(провайдер удалён)</span>` : ""}
        </div>`,
              )
              .join("")
         : `<div class="chain-empty">добавьте хотя бы одного провайдера</div>`}
       </div>`
     div.querySelector('[data-a="edit"]').onclick = (event) => {
       event.preventDefault()
       event.stopPropagation()
       debugLog("chain-edit", { name })
       openModelDialog(name)
     }
     div.querySelector(".chain-toggle").onclick = (event) => {
       event.preventDefault()
       event.stopPropagation()
       const nextEnabled = cfg.models[name].enabled === false
       debugLog("chain-toggle", { name, enabled: nextEnabled })
       if (nextEnabled) delete cfg.models[name].enabled
       else cfg.models[name].enabled = false
       save(); renderModels(); renderOpenCode()
     }
     box.append(div)
   }
    if (!entries.length) box.innerHTML = emptyStateHtml(allEntries.length ? "ничего не найдено" : "цепочек пока нет — нажми «Добавить»")
   applyStepColumns(box)
 }

// The steps inside every chain flow in as many columns as a single upstream chip
// needs, capped at three. One count for the whole tab keeps the chains aligned;
// each chain then gets the row count that fills its columns top-to-bottom.
let stepColumnsObserver = null
function applyStepColumns(box) {
  const MIN_STEP = 240
  const gap = 8
  const fit = () => {
    const available = box.querySelector(".card .chain")?.clientWidth ?? 0
    if (!available) return // hidden tab: the observer fires once it has width
    const cols = Math.max(1, Math.min(4, Math.floor((available + gap) / (MIN_STEP + gap))))
    box.dataset.stepCols = String(cols)
    for (const chain of box.querySelectorAll(".chain")) {
      const rows = Math.max(1, Math.ceil(chain.querySelectorAll(".step").length / cols))
      if (chain.style.getPropertyValue("--step-cols") !== String(cols)) chain.style.setProperty("--step-cols", cols)
      if (chain.style.getPropertyValue("--step-rows") !== String(rows)) chain.style.setProperty("--step-rows", rows)
    }
  }
  fit()
  stepColumnsObserver?.disconnect()
  stepColumnsObserver = new ResizeObserver(() => requestAnimationFrame(fit))
  stepColumnsObserver.observe(box)
}

// Cards are rebuilt after every save. Keep one document-level handler so
// actions cannot disappear when a card is re-rendered.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement
  if (!target) return
  const actionTarget = target.closest("button, [data-a], .chain-toggle")
  if (actionTarget) debugLog("click", { target: actionTarget.id || actionTarget.dataset.a || actionTarget.dataset.tab || actionTarget.textContent?.trim().slice(0, 60) })

  const chainCard = target.closest("#models .card[data-model]")
  if (chainCard) {
    const name = chainCard.dataset.model
    if (target.closest('[data-a="edit"]')) {
      event.preventDefault(); event.stopPropagation()
      return openModelDialog(name)
    }
    if (target.closest(".chain-toggle")) {
      event.preventDefault(); event.stopPropagation()
      const enabled = cfg.models[name].enabled !== false
      if (enabled) cfg.models[name].enabled = false
      else delete cfg.models[name].enabled
      save(); renderModels(); renderOpenCode()
      return
    }
  }

  const directCard = target.closest("#opencode-models .card[data-provider]")
  if (directCard) {
    const provider = directCard.dataset.provider
    if (target.closest('[data-a="edit"]')) {
      event.preventDefault(); event.stopPropagation()
      return openOpenCodeModelDialog(provider)
    }
    if (target.closest(".chain-toggle")) {
      event.preventDefault(); event.stopPropagation()
      const toggle = directCard.querySelector('[data-a="toggle"]')
      toggle.checked = !toggle.checked
      if (toggle.checked) delete cfg.opencodeModels[provider].enabled
      else cfg.opencodeModels[provider].enabled = false
      save(); renderOpencodeModels(); renderOpenCode()
    }
  }
})

const DEFAULT_OPENCODE_CONFIG = "~/.config/opencode/opencode.jsonc"
const DEFAULT_OPENCODE_PROVIDER = "provider-proxy"
// The effective default can be .json or .jsonc depending on which file exists;
// only the backend knows, so GET reports it and the GUI compares against that.
let opencodeConfigDefault = DEFAULT_OPENCODE_CONFIG

 const previewExpanded = new Set()
 function renderOpenCodePreview(id, entries) {
   const box = $(id)
   if (!entries.length) {
     box.innerHTML = `<span class="muted">Включи хотя бы одну модель или цепочку — она появится здесь после синхронизации.</span>`
     return
   }
   const expanded = previewExpanded.has(id)
   const visible = expanded ? entries : entries.slice(0, 10)
   box.innerHTML = visible.map(([name, suffix]) => `<div class="opencode-model"><strong>${esc(name)}</strong>${suffix ? `<span>(${esc(suffix)})</span>` : ""}</div>`).join("")
   if (entries.length > 15) {
     const toggle = document.createElement("button")
     toggle.type = "button"
     toggle.className = "opencode-preview-toggle"
     toggle.innerHTML = expanded ? "↑ Свернуть список" : `↓ Показать ещё ${entries.length - 10}`
     toggle.onclick = () => {
       if (expanded) previewExpanded.delete(id)
       else previewExpanded.add(id)
       renderOpenCode()
     }
     box.append(toggle)
   }
 }

 function renderOpenCode() {
  const path = cfg.opencodeConfig ?? opencodeConfigDefault
  const provider = cfg.opencodeProvider ?? DEFAULT_OPENCODE_PROVIDER
   $("oc-path").value = path
   $("oc-provider").value = provider
  syncResetVisibility()
  const chains = Object.entries(cfg.models).filter(([, def]) => def.enabled !== false)
   const direct = Object.entries(cfg.opencodeModels ?? {}).flatMap(([provider, def]) =>
      def?.enabled === false ? [] : directModelIds(provider, def).map((model) => [`${provider}/${model}`, ""]),
  )
  const entries = [...chains.map(([name, def]) => [name, `proxy, x${(def.upstreams ?? []).length}`]), ...direct]
  const status = entries.length ? plural(entries.length, "модель", "модели", "моделей") : "пока пусто"
  const enabled = cfg.integrations?.opencode?.enabled !== false
  $("oc-status").textContent = enabled ? status : "Opencode выключен"
  $("opencode-enabled").checked = enabled
  $("opencode-toggle").className = `chain-toggle ${enabled ? "is-on" : "is-off"}`
  $("opencode-toggle").dataset.tip = enabled ? "Выключить Opencode" : "Включить Opencode"
  if (enabled) renderOpenCodePreview("oc-preview", entries)
  else $("oc-preview").innerHTML = `<span class="muted">Opencode выключен — включи его, чтобы публиковать модели.</span>`
}

// Chips sit in rows of at most four, and every card uses the same count: a
// card that would fit three next to a neighbour that fits two would look
// broken, so the count is the smallest that fits the widest chip in the list.
let modelColumnsObserver = null
function applyModelColumns(box) {
  const cards = [...box.querySelectorAll(".direct-model-card")]
  if (!cards.length) return
  const gap = 8
  const fit = () => {
    // Chips truncate their ids, so a laid-out chip never reports its natural
    // width. A temporary copy with the same class and innerHTML does, and that
    // is what decides how many fit side by side.
    const probe = document.createElement("span")
    probe.className = "opencode-model"
    probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;white-space:nowrap;pointer-events:none"
    document.body.append(probe)
    let widest = 0
    for (const chip of box.querySelectorAll(".opencode-model")) {
      probe.innerHTML = chip.innerHTML
      widest = Math.max(widest, probe.getBoundingClientRect().width)
    }
    const available = box.querySelector(".provider-model-list")?.clientWidth ?? 0
    probe.remove()
    if (!available || !widest) return // hidden tab: the observer fires once it has width
    const cols = Math.max(1, Math.min(4, Math.floor((available + gap) / (widest + gap))))
    // Writing only when the count changes keeps the grid from resizing itself
    // into another observer callback, which browsers report as an interface
    // error on every drag of the window edge.
    if (box.dataset.modelCols === String(cols)) return
    box.dataset.modelCols = String(cols)
    for (const card of cards) card.style.setProperty("--model-cols", cols)
  }
  fit()
  modelColumnsObserver?.disconnect()
  modelColumnsObserver = new ResizeObserver(() => requestAnimationFrame(fit))
  modelColumnsObserver.observe(box)
}

function renderOpencodeModels() {
  const box = $("opencode-models")
  syncFilterButton("om-search-filter", directFilters)
  const allEntries = Object.entries(cfg.opencodeModels ?? {})
    .filter(([provider]) => cfg.providers[provider])
    .sort(([, a], [, b]) => Number(a?.enabled === false) - Number(b?.enabled === false))
  const query = directModelSearch.trim().toLowerCase()
  const entries = allEntries
    .filter(([provider, def]) => !query || provider.toLowerCase().includes(query) || directModelIds(provider, def).some((id) => id.toLowerCase().includes(query)))
    .filter(([, def]) => {
      if (!directFilters.size) return true
      return [...directFilters].some((kind) =>
        kind === "active" ? def?.enabled !== false : def?.enabled === false)
    })
  box.innerHTML = entries.length
    ? entries
        .map(([provider, def]) => {
          const enabled = def?.enabled !== false
           const ids = directModelIds(provider, def)
           return `<div class="card direct-model-card${enabled ? "" : " chain-disabled"}" data-provider="${esc(provider)}">
            <div class="model-card-head">
              <b class="model-title">${esc(provider)}</b>
              <div class="model-badges"></div>
              <div class="head-controls">
                <label class="chain-toggle ${enabled ? "is-on" : "is-off"}" data-tip="${enabled ? "Убрать модели провайдера из публикации" : "Вернуть модели провайдера в публикацию"}" aria-label="${enabled ? "Активен" : "Скрыт"}">
                  <input type="checkbox" data-a="toggle" ${enabled ? "checked" : ""}>
                  <span class="chain-switch" aria-hidden="true"></span>
                </label>
                <div class="model-actions">
                  <button type="button" class="icon-action" data-a="edit" data-tip="Изменить" aria-label="Изменить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
                </div>
              </div>
            </div>
             <div class="provider-model-list">${ids.length ? ids.map((id) => `<span class="opencode-model"><strong>${esc(id)}</strong>${modelContextSuffix(provider, id)}</span>`).join("") : `<span class="muted">модели не выбраны — нажми «Изменить»</span>`}</div>
          </div>`
        })
        .join("")
      : emptyStateHtml(allEntries.length ? "ничего не найдено" : "прямых моделей пока нет — нажми «Добавить»")
  applyModelColumns(box)
  for (const card of box.querySelectorAll(".direct-model-card")) {
    const provider = card.dataset.provider
    card.querySelector('[data-a="edit"]').onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      debugLog("direct-edit", { provider })
      openOpenCodeModelDialog(provider)
    }
    card.querySelector(".chain-toggle").onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const nextEnabled = cfg.opencodeModels[provider].enabled === false
      debugLog("direct-toggle", { provider, enabled: nextEnabled })
      if (nextEnabled) delete cfg.opencodeModels[provider].enabled
      else cfg.opencodeModels[provider].enabled = false
      save(); renderOpencodeModels(); renderOpenCode()
    }
  }
}

function renderSettings() {
  const settings = appSettings()
  $("s-port").value = cfg.port ?? 8787
  $("s-auth").value = cfg.authToken ?? ""
  $("s-auth").placeholder = cfg.authTokenConfigured ? "оставить текущий токен" : "не задан"
  $("s-limit").value = cfg.limitCooldownSec ?? 300
  $("s-error").value = cfg.errorCooldownSec ?? 30
  $("s-header").value = cfg.headerTimeoutSec ?? 120
  $("s-stream-idle").value = cfg.streamIdleTimeoutSec ?? 90
  $("s-session-gap").value = cfg.sessionIdleGapSec ?? 300
  $("s-pending-buffer").value = String(cfg.pendingBufferBytes ?? 8388608)
  $("s-retry-forever").checked = cfg.retryForever === true
  syncResetVisibility()
  $("s-version").textContent = cfg.appVersion ?? "—"
  $("s-theme-current").textContent = themeLabel(settings.theme)
  $("s-auto-update").checked = settings.autoUpdate
  $("s-auto-restart").checked = settings.autoRestart
  $("s-auto-restart").disabled = !settings.autoUpdate
  $("s-auto-restart-wrap").classList.toggle("is-disabled", !settings.autoUpdate)
  const desktop = isDesktopApp()
  $("s-auto-update").disabled = !desktop
  $("s-auto-update-wrap").classList.toggle("is-disabled", !desktop)
  $("s-auto-update-help").textContent = desktop ? "Проверка выполняется после запуска приложения." : "доступно в desktop-версии"
  $("s-check-update").disabled = !desktop
  $("s-check-update-wrap").classList.toggle("is-disabled", !desktop)
  $("s-rollback-open").disabled = !desktop
  $("s-rollback-wrap").classList.toggle("is-disabled", !desktop)
  $("s-autostart").checked = settings.autostart
  $("s-autostart").disabled = !desktop
  $("s-autostart-wrap").classList.toggle("is-disabled", !desktop)
  $("s-autostart-help").textContent = desktop ? "Windows и Linux" : "доступно в desktop-версии"
  $("s-create-shortcut-menu").disabled = !desktop
  $("s-create-shortcut-desktop").disabled = !desktop
  $("s-autostart-tray").checked = settings.autostartTray
  $("s-autostart-tray").disabled = !desktop || !settings.autostart
  $("s-autostart-tray-wrap").classList.toggle("is-disabled", !desktop || !settings.autostart)
  $("s-autostart-tray-help").textContent = !desktop
    ? "доступно в desktop-версии"
    : settings.autostart
      ? "Без окна — только значок в трее."
      : "сначала включи автозапуск"
  $("s-shortcut-wrap").classList.toggle("is-disabled", !desktop)
  $("s-base-url").textContent = `http://127.0.0.1:${cfg.port ?? 8787}/v1`
}

async function exportConfigFile() {
  const query = new URLSearchParams({
    keys: $("config-export-keys").checked ? "true" : "false",
    chains: $("config-export-chains").checked ? "true" : "false",
    models: $("config-export-models").checked ? "true" : "false",
  })
  const button = $("config-export")
  button.disabled = true
  try {
    const response = await api(`/api/config/export?${query}`)
    if (!response.ok) throw new Error(apiErrorMessage(await response.json().catch(() => ({})), `HTTP ${response.status}`))
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement("a")
    link.href = url
    link.download = "provider-proxy-config.json"
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    flash(true, "конфиг экспортирован ✓")
  } catch (error) {
    flash(false, `не удалось экспортировать конфиг: ${error.message ?? error}`)
  } finally {
    button.disabled = false
  }
}

async function importConfigFile(file) {
  if (!file) return
  if (!(await askConfirm("Импорт заменит настройки из выбранного файла. Продолжить?", { title: "Импорт конфигурации", okLabel: "Импортировать" }))) return
  const button = $("config-import")
  button.disabled = true
  clearTimeout(saveT)
  try {
    const imported = JSON.parse(await file.text())
    const response = await api("/api/config/import", { method: "POST", body: JSON.stringify(imported) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(apiErrorMessage(payload, `HTTP ${response.status}`))
    if (typeof imported.authToken === "string" && imported.authToken) {
      token = imported.authToken
      localStorage.setItem("pp_token", token)
    }
    const current = await api("/api/config")
    if (!current.ok) throw new Error(`не удалось перечитать конфиг: HTTP ${current.status}`)
    cfg = await current.json()
    opencodeConfigDefault = cfg.opencodeConfigDefault ?? DEFAULT_OPENCODE_CONFIG
    delete cfg.opencodeConfigDefault
    cfg.providers ??= {}
    cfg.models ??= {}
    cfg.opencodeModels ??= {}
    renderAll()
    applyTheme(appSettings().theme)
    flash(true, payload.opencodeSynced === false ? "импортирован, но Opencode не обновлен" : "конфиг импортирован ✓; перезапуск")
    setTimeout(() => {
      if (isDesktopApp()) tauriInvoke("restart_app")
      else window.location.reload()
    }, 350)
  } catch (error) {
    flash(false, `не удалось импортировать конфиг: ${error.message ?? error}`)
  } finally {
    button.disabled = false
    $("config-import-file").value = ""
  }
}

$("config-export").onclick = exportConfigFile
$("config-import").onclick = () => $("config-import-file").click()
$("config-import-file").onchange = (event) => importConfigFile(event.target.files?.[0])

let updateInfo = null
let updateBusy = false
// The navigation entry above "Settings" is the only update surface: it shows
// "Обновить до X", then the download bar, then "Перезапустить". Check results
// that need no action (nothing found, errors) are plain toasts.
const updateNavButton = $("update-nav-button")
const updateNavLabel = $("update-nav-label")
const updateNavProgress = $("update-progress")
const updateNavProgressFill = $("update-progress-fill")
function setUpdateNav(state) {
  // null hides it; { mode: "update" | "progress" | "restart", done?, total? }
  if (!state) {
    updateNavButton.hidden = true
    updateNavProgress.hidden = true
    updateNavProgressFill.style.width = "0%"
    updateNavButton.dataset.mode = ""
    updateNavButton.dataset.tip = ""
    return
  }
  updateNavButton.hidden = false
  updateNavButton.dataset.mode = state.mode
  if (state.mode === "progress") {
    const done = Number(state.done) || 0
    const total = Number(state.total) || 0
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0
    // A server that sends no Content-Length leaves no percentage to show, so
    // report the downloaded size instead of an empty bar with no feedback.
    updateNavLabel.textContent = total
      ? `Обновление ${percent}%`
      : done
        ? `Обновление ${(done / 1048576).toFixed(1)} МБ`
        : "Обновление"
    updateNavProgress.hidden = false
    updateNavProgress.classList.toggle("is-indeterminate", !total)
    updateNavProgressFill.style.width = total ? `${percent}%` : "0%"
    updateNavButton.dataset.tip = "Идёт загрузка обновления"
    return
  }
  updateNavProgress.hidden = true
  updateNavProgress.classList.remove("is-indeterminate")
  updateNavProgressFill.style.width = "0%"
  updateNavLabel.textContent = state.mode === "restart" ? "Перезапустить" : `Обновить до ${state.version}`
  updateNavButton.dataset.tip = state.mode === "restart" ? "Перезапустить и применить обновление" : `Установить версию ${state.version}`
}
// Events emitted during a download can still land after the command resolved.
// Without this guard a late frame flipped "Перезапустить" back to "Обновление"
// and left it that way.
window.__TAURI__?.event?.listen?.("update-progress", (event) => {
  if (!updateBusy) return
  const payload = event.payload ?? {}
  setUpdateNav({ mode: "progress", done: payload.done, total: payload.total })
})
updateNavButton.onclick = () => {
  if (updateNavButton.dataset.mode === "restart") return restartDesktop()
  installDesktopUpdate(appSettings().autoRestart)
}
function restartDesktop() {
  if (isDesktopApp()) tauriInvoke("restart_app")
}
async function installDesktopUpdate(restart = false) {
  if (!isDesktopApp() || updateBusy) return
  updateBusy = true
  setUpdateNav({ mode: "progress", done: 0, total: 0 })
  try {
    const installed = await tauriInvoke("install_update", { restart })
    if (!installed) {
      updateInfo = null
      setUpdateNav(null)
      flash(true, "обновлений нет")
    } else if (!restart) {
      // Downloaded and staged: the app must restart for it to take effect.
      setUpdateNav({ mode: "restart" })
      flash(true, "обновление загружено — перезапусти приложение")
    }
  } catch (error) {
    setUpdateNav(updateInfo ? { mode: "update", version: updateInfo.version } : null)
    flash(false, `не удалось обновить: ${error.message ?? error}`)
  } finally {
    updateBusy = false
  }
}
async function checkForDesktopUpdate(manual = false) {
  if (!isDesktopApp() || updateBusy) return
  const checkButton = $("s-check-update")
  if (manual) {
    checkButton.disabled = true
    checkButton.textContent = "Проверяю…"
  }
  try {
    const info = await tauriInvoke("check_for_update")
    if (!info) {
      updateInfo = null
      setUpdateNav(null)
      if (manual) flash(true, "обновлений нет")
      return
    }
    updateInfo = info
    // After a rollback the discovery may be at or below where the user left.
    // It is offered only for a manual check and never auto-installed, so the
    // rollback is not silently undone.
    if (info.gated) {
      setUpdateNav(null)
      if (manual) flash(false, `доступна версия ${info.version}, но она не выше той, с которой ты откатился`)
      return
    }
    const settings = appSettings()
    if (settings.autoUpdate) {
      // Automatic download; the restart is separate, exactly like the manual path.
      return installDesktopUpdate(settings.autoRestart)
    }
    setUpdateNav({ mode: "update", version: info.version })
    if (manual) flash(true, `доступна новая версия ${info.version}`)
  } catch (error) {
    const message = error.message ?? String(error)
    debugLog("update-check-failed", { message })
    flash(false, `не удалось проверить обновления: ${message}`)
  } finally {
    if (manual) {
      checkButton.disabled = false
      checkButton.textContent = "Проверить"
    }
  }
}
// Theme picker: one button per palette, each tinted by its own tokens so the
// swatch shows the real colours before the user commits to it.
let themeQuery = ""
let themeOnlyCurrent = false
// Each dot paints one token; the button carries data-theme-preview, so the
// variables resolve to that theme's palette without touching the page.
const THEME_COLOR_KEYS = ["--bg", "--accent", "--success", "--warning", "--danger", "--text"]
function renderThemeDialog() {
  const current = appSettings().theme
  const query = themeQuery.trim().toLowerCase()
  const shown = (query ? THEMES.filter((theme) => theme.label.toLowerCase().includes(query) || theme.id.includes(query)) : THEMES).filter((theme) => !themeOnlyCurrent || theme.id === current)
  $("theme-search-result").textContent = query ? `${shown.length} из ${THEMES.length}` : ""
  $("theme-options").innerHTML = shown.length
    ? shown
        .map(({ id, label }) => {
          const active = id === current
          const dots = THEME_COLOR_KEYS.map((key) => `<span class="ts-dot" style="background:var(${key})"></span>`).join("")
          return `<button type="button" class="theme-option${active ? " active" : ""}" data-theme-id="${esc(id)}" data-theme-preview="${esc(id)}" role="option" aria-selected="${active}">
      <span class="theme-option-dots">${dots}</span>
      <span class="theme-option-name">${esc(label)}</span>
      ${active ? '<span class="theme-option-check" aria-hidden="true">✓</span>' : ""}
    </button>`
        })
        .join("")
    : emptyStateHtml("ничего не найдено")
  $("theme-options").querySelectorAll("[data-theme-id]").forEach((button) => {
    button.onclick = () => {
      appSettings().theme = button.dataset.themeId
      applyTheme(button.dataset.themeId)
      save()
      renderSettings()
      renderThemeDialog()
    }
  })
}

async function syncAutostartSetting() {
  if (!isDesktopApp()) return
  try {
    appSettings().autostart = Boolean(await tauriInvoke("autostart_enabled"))
    appSettings().autostartTray = Boolean(await tauriInvoke("autostart_tray_enabled"))
    renderSettings()
  } catch (error) {
    $("s-autostart").disabled = true
    $("s-autostart-help").textContent = `ошибка: ${error.message ?? error}`
  }
}

async function createAppShortcut(desktop) {
  if (!isDesktopApp()) return
  const button = $(desktop ? "s-create-shortcut-desktop" : "s-create-shortcut-menu")
  const label = button.textContent
  button.disabled = true
  button.textContent = "Создаю…"
  try {
    await tauriInvoke("create_app_shortcut", { desktop })
    // The saved path is long and unbreakable; the toast already confirms it,
    // so the helper text keeps its short description.
    flash(true, desktop ? "ярлык добавлен на рабочий стол" : "ярлык добавлен в меню приложений")
  } catch (error) {
    flash(false, `не удалось создать ярлык: ${error.message ?? error}`)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

$("s-create-shortcut-menu").onclick = () => createAppShortcut(false)
$("s-create-shortcut-desktop").onclick = () => createAppShortcut(true)

$("settings-shutdown").onclick = async () => {
  if (!(await askConfirm("Выйти из приложения и закрыть его вкладку?", { title: "Выход", okLabel: "Выйти", danger: true }))) return
  const button = $("settings-shutdown")
  button.disabled = true
  button.textContent = "Выхожу…"
  try {
    const response = await api("/api/shutdown", { method: "POST" })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(apiErrorMessage(payload, `HTTP ${response.status}`))
    flash(true, "выход из приложения…")
    showTab("providers")
    setTimeout(() => {
      try { window.close() } catch { /* browser may forbid closing a user-opened tab */ }
      if (!document.hidden) {
        document.dataset.tip = "Provider Proxy — закрыто"
        document.body.innerHTML = '<main style="min-height:100vh;display:grid;place-items:center;padding:32px"><p style="color:#9aaabd">Приложение завершено. Вкладку можно закрыть.</p></main>'
      }
    }, 250)
  } catch (error) {
    button.disabled = false
    button.textContent = "Выйти из приложения"
    flash(false, `не удалось выйти из приложения: ${error.message}`)
  }
}

const dlgModelSettings = $("dlg-model-settings")
let modelSettingsDraft = null
function openModelSettings(provider, id) {
  const info = modelDetails(provider, id) ?? {}
  const values = contextValues(info)
  modelSettingsDraft = { provider, id }
  dlgModelSettings.returnValue = ""
  $("dms-model").textContent = `${provider}/${id}`
  // The stored `image` flag is the manual override; absent means "auto". The
  // select shows the type the model actually has, so an auto-detected image
  // model is not presented as "определять автоматически".
  $("dms-kind").value = isImageModel(provider, id) ? "image" : "chat"
  $("dms-kind-auto").hidden = info.image === true || info.image === false
  $("dms-context").value = values.manual ? String(values.manual) : ""
  $("dms-context").max = values.provider ? String(values.provider) : ""
  $("dms-context-reset").hidden = !values.manual
  dlgModelSettings.showModal()
  $("dms-context").focus()
}
$("dms-cancel").onclick = () => dlgModelSettings.close()
$("dms-context-reset").onclick = async () => {
  if (!(await askConfirm("Сбросить заданный контекст модели?", { title: "Сброс контекста", okLabel: "Сбросить" }))) return
  // Saving an empty field drops the manual value, so the next /v1/models
  // refresh sets the context again on its own.
  $("dms-context").value = ""
  $("dms-context-reset").hidden = true
  $("dms-context").focus()
}
$("dms-context").oninput = () => { $("dms-context-reset").hidden = !$("dms-context").value.trim() }
dlgModelSettings.addEventListener("close", () => {
  if (dlgModelSettings.returnValue !== "save" || !modelSettingsDraft) return
  const { provider, id } = modelSettingsDraft
  const providerConfig = cfg.providers[provider]
  if (!providerConfig) return
  const raw = $("dms-context").value.trim()
  const info = { ...(providerConfig.modelInfo?.[id] ?? {}) }
  // Manual type override: true/false is stored; the auto hint only hides/shows.
  const kind = $("dms-kind").value
  if (kind === "image") info.image = true
  else if (kind === "chat") info.image = false
  const maxContext = Number(info.providerContextLength)
  if (raw) {
    const context = Number(raw)
    if (!Number.isSafeInteger(context) || context <= 0) return flash(false, "контекст должен быть положительным целым числом")
    if (Number.isSafeInteger(maxContext) && maxContext > 0 && context > maxContext) return flash(false, `контекст не может быть больше ${formatContext(maxContext)}`)
    info.contextLength = context
    info.contextLengthManual = true
  } else {
    delete info.contextLengthManual
    if (Number(info.providerContextLength) > 0) info.contextLength = Number(info.providerContextLength)
    else delete info.contextLength
  }
  providerConfig.modelInfo ??= {}
  if (Object.keys(info).length) providerConfig.modelInfo[id] = info
  else delete providerConfig.modelInfo[id]
  save()
  renderProviderModels()
  renderModels()
  renderOpencodeModels()
})

const dlgImageSettings = $("dlg-image-settings")
const imageSkillStatusNode = $("image-skill-status")
const imageSkillPathNode = $("image-skill-path")
const imageSkillInstallButton = $("image-skill-install")
$("integrations-advanced").onclick = () => {
  $("dlg-integrations-advanced").showModal()
  loadImageSkillStatus()
}
$("image-skill-settings").onclick = () => {
  dlgImageSettings.showModal()
  renderImageSettings()
}
$("image-settings-cancel").onclick = () => dlgImageSettings.close()

function renderImageSkillStatus(state = {}) {
  imageSkillPathNode.textContent = state.path ?? "путь пока неизвестен"
  imageSkillStatusNode.className = "skill-status" + (state.same ? " is-ok" : state.installed ? " is-warn" : "")
  imageSkillStatusNode.textContent = state.same ? "установлен" : state.installed ? "есть другая версия" : "не установлен"
  imageSkillInstallButton.textContent = state.installed && !state.same ? "Обновить скилл" : "Добавить скилл"
}

async function loadImageSkillStatus() {
  imageSkillStatusNode.className = "skill-status"
  imageSkillStatusNode.textContent = "проверяю…"
  try {
    const response = await api("/api/skills/image-generation")
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(apiErrorMessage(payload, `HTTP ${response.status}`))
    renderImageSkillStatus(payload)
  } catch (error) {
    imageSkillPathNode.textContent = "—"
    imageSkillStatusNode.className = "skill-status is-warn"
    imageSkillStatusNode.textContent = `ошибка: ${imageSkillErrorMessage(error.message)}`
  }
}

async function installImageSkill(overwrite = false) {
  imageSkillInstallButton.disabled = true
  imageSkillStatusNode.className = "skill-status"
  imageSkillStatusNode.textContent = "устанавливаю…"
  try {
    const response = await api("/api/skills/image-generation", { method: "POST", body: JSON.stringify({ overwrite }) })
    const payload = await response.json().catch(() => ({}))
    if (response.status === 409 && !overwrite) {
      const shouldOverwrite = await askConfirm("В этом месте уже есть другая версия skill. Обновить её встроенной версией?", { title: "Обновить skill", okLabel: "Обновить" })
      if (shouldOverwrite) return installImageSkill(true)
      renderImageSkillStatus(payload)
      return
    }
    if (!response.ok) throw new Error(apiErrorMessage(payload, `HTTP ${response.status}`))
    renderImageSkillStatus(payload)
    flash(true, "skill для генерации изображений добавлен ✓")
  } catch (error) {
    renderImageSkillStatus({ path: imageSkillPathNode.textContent, installed: false, same: false })
    imageSkillStatusNode.textContent = `ошибка: ${imageSkillErrorMessage(error.message)}`
    flash(false, `не удалось добавить skill: ${imageSkillErrorMessage(error.message)}`)
  } finally {
    imageSkillInstallButton.disabled = false
  }
}

imageSkillInstallButton.onclick = () => installImageSkill()

$("oc-path").onchange = (e) => {
  const value = e.target.value.trim()
  if (value && value !== opencodeConfigDefault) cfg.opencodeConfig = value
  else delete cfg.opencodeConfig
  renderOpenCode(); save()
}
$("oc-provider").onchange = (e) => {
  const value = e.target.value.trim()
  if (value && value !== DEFAULT_OPENCODE_PROVIDER) cfg.opencodeProvider = value
  else delete cfg.opencodeProvider
  renderOpenCode(); save()
}
const SETTINGS_RESET_DEFAULTS = {
  "s-port": "8787",
  "s-limit": "300",
  "s-error": "30",
  "s-header": "120",
  "s-stream-idle": "90",
  "s-session-gap": "300",
  "s-pending-buffer": "8388608",
}
function syncResetVisibility() {
  document.querySelectorAll("[data-reset]").forEach((button) => {
    const id = button.dataset.reset
    const control = $(id)
    if (!control) return
    if (id === "s-retry-forever") button.hidden = !control.checked
    else if (id === "oc-path") button.hidden = control.value === opencodeConfigDefault
    else if (id === "oc-provider") button.hidden = control.value === DEFAULT_OPENCODE_PROVIDER
    else button.hidden = control.value === SETTINGS_RESET_DEFAULTS[id]
  })
}
// Live typing must reveal/hide the reset immediately, not only on commit.
document.addEventListener("input", syncResetVisibility)
document.addEventListener("change", syncResetVisibility)

document.querySelectorAll("[data-reset]").forEach((button) => {
  button.onclick = async () => {
    const id = button.dataset.reset
    if (!(await askConfirm("Вернуть значение по умолчанию?", { title: "", okLabel: "Подтвердить сброс" }))) return
    if (id === "oc-path") delete cfg.opencodeConfig
    else if (id === "oc-provider") delete cfg.opencodeProvider
    else if (id === "s-port") delete cfg.port
    else if (id === "s-limit") delete cfg.limitCooldownSec
    else if (id === "s-error") delete cfg.errorCooldownSec
    else if (id === "s-header") delete cfg.headerTimeoutSec
    else if (id === "s-stream-idle") delete cfg.streamIdleTimeoutSec
    else if (id === "s-session-gap") delete cfg.sessionIdleGapSec
    else if (id === "s-retry-forever") delete cfg.retryForever
    else if (id === "s-pending-buffer") delete cfg.pendingBufferBytes
    if (id === "s-retry-forever") $(id).checked = false
    else if (id === "s-pending-buffer") $(id).value = "8388608"
    renderSettings()
    if (id === "oc-path" || id === "oc-provider") renderOpenCode()
    save()
  }
})
$("opencode-toggle").onclick = (event) => {
  event.preventDefault()
  const enabled = cfg.integrations?.opencode?.enabled !== false
  cfg.integrations ??= {}
  cfg.integrations.opencode ??= {}
  if (enabled) cfg.integrations.opencode.enabled = false
  else delete cfg.integrations.opencode.enabled
  renderOpenCode()
  save()
}

const num = (id, key) => ($(id).onchange = (e) => { cfg[key] = Number(e.target.value) || undefined; save() })
num("s-port", "port")
num("s-limit", "limitCooldownSec")
num("s-error", "errorCooldownSec")
num("s-header", "headerTimeoutSec")
num("s-stream-idle", "streamIdleTimeoutSec")
// A session gap under 30s would make short pauses look like activity spikes.
$("s-session-gap").onchange = (e) => {
  cfg.sessionIdleGapSec = Math.min(86400, Math.max(30, Number(e.target.value) || 300))
  e.target.value = cfg.sessionIdleGapSec
  save()
}
$("s-pending-buffer").onchange = (e) => {
  cfg.pendingBufferBytes = Number(e.target.value)
  save()
}
$("s-retry-forever").onchange = (e) => {
  cfg.retryForever = e.target.checked
  save()
}
$("s-theme-open").onclick = () => {
  themeQuery = ""
  $("theme-search").value = ""
  renderThemeDialog()
  $("dlg-theme").showModal()
}
$("theme-close").onclick = () => $("dlg-theme").close()
$("theme-search").oninput = (event) => {
  themeQuery = event.target.value
  renderThemeDialog()
  const field = $("theme-search")
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
}
$("theme-search-clear").onclick = () => {
  themeQuery = ""
  $("theme-search").value = ""
  renderThemeDialog()
  $("theme-search").focus()
}
$("s-auto-update").onchange = (e) => {
  appSettings().autoUpdate = e.target.checked
  renderSettings()
  save()
  if (e.target.checked) checkForDesktopUpdate()
}
$("s-check-update").onclick = () => checkForDesktopUpdate(true)
const dlgRollback = $("dlg-rollback")
let rollbackVersions = null
let rollbackQuery = ""
let rollbackFilter = "older" // older | current | all
const renderRollbackList = () => {
  const list = $("rollback-list")
  if (!rollbackVersions) return
  const query = rollbackQuery.trim().toLowerCase()
  const rows = rollbackVersions.filter((v) => {
    if (rollbackFilter === "older" && v.current) return false
    if (rollbackFilter === "current" && !v.current) return false
    return !query || v.version.toLowerCase().includes(query)
  })
  $("rollback-count").textContent = rows.length ? `${rows.length} из ${rollbackVersions.length}` : "ничего не найдено"
  list.innerHTML = rows.length
    ? rows.map((v) => {
        const when = v.published ? new Date(v.published).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : ""
        const label = v.current ? '<span class="rollback-tag">текущая</span>' : ""
        return `<button type="button" class="rollback-row${v.current ? " is-current" : ""}" data-version="${esc(v.version)}"${v.current ? " disabled" : ""}><span class="rollback-version">${esc(v.version)}${label}</span><span class="rollback-date">${esc(when)}</span></button>`
      }).join("")
    : `<p class="muted" style="margin:6px 0">Версий не найдено.</p>`
  list.querySelectorAll("[data-version]").forEach((button) => {
    button.onclick = () => {
      const version = button.dataset.version
      dlgRollback.close()
      startRollback(version)
    }
  })
}
async function loadRollbackVersions() {
  if (rollbackVersions) return renderRollbackList()
  $("rollback-list").innerHTML = '<p class="muted" style="margin:6px 0">Загружаю список…</p>'
  $("rollback-count").textContent = ""
  try {
    rollbackVersions = await tauriInvoke("list_versions")
    renderRollbackList()
  } catch (error) {
    $("rollback-list").innerHTML = `<p class="muted" style="margin:6px 0">Не удалось получить список: ${esc(error.message ?? error)}</p>`
  }
}
async function startRollback(version) {
  if (!version || updateBusy) return
  updateBusy = true
  setUpdateNav({ mode: "progress", done: 0, total: 0 })
  flash(true, `откатываю на ${version}…`)
  // The command exits the app once the swap is scheduled, so the choice must be
  // saved first: a deliberate rollback turns automatic updates off, otherwise
  // the next check would re-install the version the user just left.
  const previousAutoUpdate = appSettings().autoUpdate
  appSettings().autoUpdate = false
  save()
  try {
    if (!(await tauriInvoke("rollback_to", { version }))) {
      appSettings().autoUpdate = previousAutoUpdate
      save()
      renderSettings()
      setUpdateNav(null)
    }
  } catch (error) {
    appSettings().autoUpdate = previousAutoUpdate
    save()
    renderSettings()
    setUpdateNav(null)
    flash(false, `не удалось откатить: ${error.message ?? error}`)
  } finally {
    updateBusy = false
  }
}
$("s-rollback-open").onclick = () => {
  rollbackQuery = ""
  rollbackFilter = "older"
  $("rollback-search").value = ""
  dlgRollback.showModal()
  loadRollbackVersions()
}
$("rollback-search").oninput = (event) => {
  rollbackQuery = event.target.value
  renderRollbackList()
}
$("rollback-search-clear").onclick = () => {
  rollbackQuery = ""
  $("rollback-search").value = ""
  renderRollbackList()
  $("rollback-search").focus()
}
$("rollback-filter-menu").onclick = () => {
  const options = [["older", "Только старше текущей"], ["all", "Все версии"], ["current", "Только текущая"]]
  openSearchMenu($("rollback-filter-menu"), options.map(([value, label]) => ({
    label, checked: rollbackFilter === value,
    action: () => { rollbackFilter = value; renderRollbackList() },
  })))
}
$("rollback-cancel").onclick = () => dlgRollback.close()
$("s-auto-restart").onchange = (e) => {
  appSettings().autoRestart = e.target.checked
  save()
}
async function applyAutostart(enabled, tray, onError) {
  try {
    appSettings().autostart = Boolean(await tauriInvoke("set_autostart", { enabled, tray }))
    // The command reports only whether autostart is on; keep the tray choice
    // the user just made so the second checkbox does not snap back.
    appSettings().autostartTray = tray
    save()
  } catch (error) {
    onError()
    flash(false, `автозапуск: ${error.message ?? error}`)
  } finally {
    renderSettings()
  }
}
$("s-autostart").onchange = async (e) => {
  const enabled = e.target.checked
  e.target.disabled = true
  // Turning autostart off keeps the tray choice for next time.
  await applyAutostart(enabled, appSettings().autostartTray, () => (e.target.checked = !enabled))
}
$("s-autostart-tray").onchange = async (e) => {
  const tray = e.target.checked
  e.target.disabled = true
  await applyAutostart(true, tray, () => (e.target.checked = !tray))
}
$("s-auth").onchange = (e) => {
  const v = e.target.value.trim()
  if (v) {
    cfg.authToken = v
    delete cfg.authTokenConfigured
  } else {
    delete cfg.authToken
    delete cfg.authTokenConfigured
  }
  token = v
  localStorage.setItem("pp_token", v)
  save()
}

$("u-session-search").oninput = (e) => {
  sessionQuery = e.target.value
  sessionPage = 0
  renderUsageReportKeepingScroll(usageReport)
}
$("u-session-search-clear").onclick = () => {
  sessionQuery = ""
  sessionPage = 0
  $("u-session-search").value = ""
  if (usageReport) renderUsageReportKeepingScroll(usageReport)
  $("u-session-search").focus()
}

// Every session across the stored days, merged by id: the per-day view only
// sees one bucket, so a session that ran yesterday and today looked missing.
function allSessions(days) {
  const merged = {}
  for (const day of days ?? []) {
    for (const [id, stat] of Object.entries(day.sessions ?? {})) {
      const row = (merged[id] ??= { requests: 0, ok: 0, limits: 0, errors: 0, tokensIn: 0, tokensOut: 0, activeMs: 0, firstSeen: 0, lastSeen: 0 })
      row.requests += Number(stat.requests) || 0
      row.ok += Number(stat.ok) || 0
      row.limits += Number(stat.limits) || 0
      row.errors += Number(stat.errors) || 0
      row.tokensIn += Number(stat.tokensIn) || 0
      row.tokensOut += Number(stat.tokensOut) || 0
      row.activeMs += Number(stat.activeMs) || 0
      const first = Number(stat.firstSeen) || 0
      const last = Number(stat.lastSeen) || 0
      if (first && (!row.firstSeen || first < row.firstSeen)) row.firstSeen = first
      if (last > row.lastSeen) row.lastSeen = last
    }
  }
  return merged
}

let allSessionQuery = ""
let allSessionPage = 0
function renderAllSessions() {
  const days = Array.isArray(usageReport?.days) ? usageReport.days : []
  const rows = usageSessionRows(allSessions(days), usageReport?.sessionTitles, allSessionQuery)
  const pages = Math.max(1, Math.ceil(rows.length / SESSION_PAGE_SIZE))
  if (allSessionPage >= pages) allSessionPage = pages - 1
  const slice = rows.slice(allSessionPage * SESSION_PAGE_SIZE, (allSessionPage + 1) * SESSION_PAGE_SIZE)
  $("all-sessions-count").textContent = ""
  $("all-sessions-table").innerHTML = sessionTableHtml(slice)
  // One page needs no controls: the drawer only exists while there is a choice.
  $("all-sessions-drawer").hidden = pages <= 1
  $("all-sessions-pager").innerHTML = pages > 1
    ? `<button type="button" data-page="${allSessionPage - 1}"${allSessionPage === 0 ? " disabled" : ""}>Назад</button><span class="muted">${allSessionPage + 1} / ${pages}</span><button type="button" data-page="${allSessionPage + 1}"${allSessionPage === pages - 1 ? " disabled" : ""}>Вперёд</button>`
    : ""
  $("all-sessions-pager").querySelectorAll("[data-page]").forEach((button) => {
    button.onclick = () => {
      allSessionPage = Number(button.dataset.page) || 0
      renderAllSessions()
    }
  })
}
$("u-session-all").onclick = () => {
  allSessionQuery = ""
  allSessionPage = 0
  $("all-sessions-search").value = ""
  renderAllSessions()
  $("dlg-all-sessions").showModal()
}
$("all-sessions-drawer-toggle").onclick = () => {
  const body = $("all-sessions-pager")
  const open = body.hidden
  body.hidden = !open
  $("all-sessions-drawer-toggle").setAttribute("aria-expanded", String(open))
}
$("all-sessions-search").oninput = (e) => {
  allSessionQuery = e.target.value
  allSessionPage = 0
  renderAllSessions()
}
$("all-sessions-search-clear").onclick = () => {
  allSessionQuery = ""
  $("all-sessions-search").value = ""
  allSessionPage = 0
  renderAllSessions()
  $("all-sessions-search").focus()
}
$("providers-filter").oninput = (e) => {
  providersFilter = e.target.value
  renderProviders()
}
$("providers-filter-clear").onclick = () => {
  providersFilter = ""
  $("providers-filter").value = ""
  renderProviders()
  $("providers-filter").focus()
}
$("m-search").oninput = (event) => { modelSearch = event.target.value; renderModels() }
$("m-search-clear").onclick = () => {
  modelSearch = ""
  chainFilters.clear()
  syncFilterButton("m-search-filter", chainFilters)
  $("m-search").value = ""
  renderModels()
  $("m-search").focus()
}
$("om-search").oninput = (event) => { directModelSearch = event.target.value; renderOpencodeModels() }
$("om-search-clear").onclick = () => {
  directModelSearch = ""
  directFilters.clear()
  syncFilterButton("om-search-filter", directFilters)
  $("om-search").value = ""
  renderOpencodeModels()
  $("om-search").focus()
}
$("m-search-filter").onclick = () => {
  const options = [["active", "Активные"], ["disabled", "Скрытые"], ["empty", "Пустые"]]
  openSearchMenu($("m-search-filter"), options.map(([value, label]) => ({
    label, toggle: true, stayOpen: true, checked: chainFilters.has(value),
    action: () => { toggleFilter("m-search-filter", chainFilters, value); renderModels() },
  })))
}
$("om-search-filter").onclick = () => {
  const options = [["active", "Активные"], ["disabled", "Скрытые"]]
  openSearchMenu($("om-search-filter"), options.map(([value, label]) => ({
    label, toggle: true, stayOpen: true, checked: directFilters.has(value),
    action: () => { toggleFilter("om-search-filter", directFilters, value); renderOpencodeModels() },
  })))
}
$("theme-search-filter").onclick = () => {
  openSearchMenu($("theme-search-filter"), [
    { label: "Все темы", checked: !themeOnlyCurrent, action: () => { themeOnlyCurrent = false; renderThemeDialog() } },
    { label: "Только текущая", checked: themeOnlyCurrent, action: () => { themeOnlyCurrent = true; renderThemeDialog() } },
  ])
}

function renderAll() {
  renderProviders()
  renderProviderModels()
  renderModels()
  renderOpencodeModels()
  renderImageGenerator()
  renderOpenCode()
  renderSettings()
}
