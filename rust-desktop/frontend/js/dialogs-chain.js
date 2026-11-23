const dlgModel = $("dlg-model")
let draft = null // { original, enabled, upstreams: [{provider, model}] }
let pickProvider = null // провайдер, выбранный в пикере «или из выбранных моделей провайдера»
let chainColumnsObserver = null
let chainProviderFilter = ""
// Ticks filter for the model picker: empty means every model.
let pickFilters = new Set()

function openModelDialog(name = null) {
  const src = name ? cfg.models[name] : null
  draft = { original: name, enabled: src?.enabled !== false, upstreams: src ? JSON.parse(JSON.stringify(src.upstreams ?? [])) : [] }
  dlgModel.returnValue = ""
    $("dm-title").textContent = name ? "Изменить цепочку" : "Добавить цепочку"
  $("dm-name").value = name ?? ""
  $("dm-delete").hidden = !name
  pickProvider = null
  chainProviderFilter = ""
  filters.delete("dm-pick-list")
  pickFilters.clear()
  renderModelDialog()
  dlgModel.showModal()
}

function renderModelDialog() {
  const ups = draft.upstreams
  const provNames = Object.keys(cfg.providers)

  $("dm-chain").innerHTML = ups.length
    ? ups.map((u, i) => `
        <div class="chain-row" draggable="true" data-chain-index="${i}">
          <span class="drag-handle" data-tip="Перетащить модель"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.5"></circle><circle cx="15" cy="6" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="9" cy="18" r="1.5"></circle><circle cx="15" cy="18" r="1.5"></circle></svg></span>
          <span class="step-number" aria-hidden="true">${i + 1}</span>
          <div class="chain-model-label"><code>${esc(u.model ?? "")}</code><span class="muted">${esc(u.provider)}${u.provider && !cfg.providers[u.provider] ? " · удалён" : ""}</span></div>
          <div class="row-controls">
            <button class="icon-button" type="button" data-a="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Переместить шаг ${i + 1} выше" data-tip="Выше"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg></button>
            <button class="icon-button" type="button" data-a="down" data-i="${i}" ${i === ups.length - 1 ? "disabled" : ""} aria-label="Переместить шаг ${i + 1} ниже" data-tip="Ниже"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>
            <button class="icon-button danger" type="button" data-a="rm" data-i="${i}" aria-label="Удалить модель ${i + 1}" data-tip="Удалить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg></button>
          </div>
        </div>`).join("")
    : emptyInlineHtml("Цепочка пуста — выбери модель ниже")
  // Columns follow the pane width, like the chain cards on the Chains tab.
  const chainBox = $("dm-chain")
  const fitChainColumns = () => {
    const available = chainBox.clientWidth
    if (!available) return
    const cols = Math.max(1, Math.min(2, Math.floor((available + 8) / (330 + 8))))
    // Rows are counted so the grid can fill downwards first.
    const rows = Math.max(1, Math.ceil(ups.length / cols))
    if (chainBox.dataset.chainCols === `${cols}x${rows}`) return
    chainBox.dataset.chainCols = `${cols}x${rows}`
    chainBox.style.setProperty("--chain-cols", cols)
    chainBox.style.setProperty("--chain-rows", rows)
  }
  fitChainColumns()
  chainColumnsObserver?.disconnect()
  chainColumnsObserver = new ResizeObserver(() => requestAnimationFrame(fitChainColumns))
  chainColumnsObserver.observe(chainBox)

  const on = (a, fn) => $("dm-chain").querySelectorAll(`[data-a="${a}"]`).forEach((b) => (b.onclick = () => fn(+b.dataset.i)))
  on("up", (i) => { const u = draft.upstreams; [u[i - 1], u[i]] = [u[i], u[i - 1]]; renderModelDialog() })
  on("down", (i) => { const u = draft.upstreams; [u[i + 1], u[i]] = [u[i], u[i + 1]]; renderModelDialog() })
  on("rm", (i) => { draft.upstreams.splice(i, 1); renderModelDialog() })
  let draggedIndex = null
  const rows = [...$("dm-chain").querySelectorAll(".chain-row")]
  rows.forEach((row) => {
    row.ondragstart = (event) => {
      draggedIndex = Number(row.dataset.chainIndex)
      row.classList.add("is-dragging")
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", String(draggedIndex))
    }
    row.ondragend = () => {
      draggedIndex = null
      rows.forEach((item) => item.classList.remove("is-dragging", "is-drop-target"))
    }
    row.ondragover = (event) => {
      event.preventDefault()
      row.classList.add("is-drop-target")
    }
    row.ondragleave = () => row.classList.remove("is-drop-target")
    row.ondrop = (event) => {
      event.preventDefault()
      const from = draggedIndex ?? Number(event.dataTransfer.getData("text/plain"))
      const to = Number(row.dataset.chainIndex)
      if (!Number.isInteger(from) || from === to || !draft.upstreams[from]) return
      const [item] = draft.upstreams.splice(from, 1)
      draft.upstreams.splice(to, 0, item)
      renderModelDialog()
    }
  })

  // Keep the selected provider label in sync with the lower picker pane.
  const prefer = pickProvider ?? draft.upstreams.at(-1)?.provider ?? provNames[0]
  if (!pickProvider && prefer) pickProvider = prefer
  $("dm-current-line").innerHTML = `<strong>${ups.length ? `Модели в цепочке · ${ups.length}` : "Порядок цепочки"}</strong>`
  $("dm-provider-current").innerHTML = `<strong>${esc(pickProvider ?? "Выбери провайдера")}</strong>`

  const providerQuery = chainProviderFilter.trim().toLowerCase()
  const shownProviders = providerQuery ? provNames.filter((pn) => pn.toLowerCase().includes(providerQuery)) : provNames
   $("dm-provider-options").innerHTML = shownProviders.length
    ? providerOptionsHtml(shownProviders, pickProvider)
    : emptyInlineHtml("ничего не найдено")
  $("dm-provider-options").querySelectorAll("[data-provider]").forEach((button) => {
    button.onclick = () => {
      pickProvider = button.dataset.provider
      filters.delete("dm-pick-list")
      renderModelDialog()
    }
  })
  $("dm-provider-filter").value = chainProviderFilter
  $("dm-provider-filter").oninput = (e) => {
    chainProviderFilter = e.target.value
    renderModelDialog()
    const input = $("dm-provider-filter")
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
  $("dm-provider-filter-clear").onclick = () => {
    chainProviderFilter = ""
    renderModelDialog()
    $("dm-provider-filter").focus()
  }
  renderPick()
}

function renderPick() {
  const provider = pickProvider
  if (!provider) return ($("dm-pick-list").innerHTML = emptyInlineHtml("Сначала выбери провайдера"))
  const allIds = (cfg.providers[provider]?.models ?? []).filter((id) => !isImageModel(provider, id))
  const used = new Set(draft.upstreams.filter((upstream) => upstream.provider === provider).map((upstream) => upstream.model))
  const ft = (filters.get("dm-pick-list") ?? "").toLowerCase()
  const shown = allIds.filter((id) => {
    if (!id.toLowerCase().includes(ft)) return false
    // Both boxes on means "either", i.e. no restriction.
    if (pickFilters.has("selected") && !pickFilters.has("unselected") && !used.has(id)) return false
    if (pickFilters.has("unselected") && !pickFilters.has("selected") && used.has(id)) return false
    return true
  })
  $("dm-pick-list").innerHTML = `
    ${searchFieldHtml("dm-pick-search", "dm-pick-search-clear", "Поиск моделей", filters.get("dm-pick-list") ?? "", "dm-pick-filter")}
    <div class="direct-model-grid">
      ${shown.length
        ? modelCardsHtml(provider, shown, { checked: (id) => used.has(id) })
        : emptyInlineHtml(allIds.length ? "ничего не найдено" : `у «${provider}» нет доступных моделей`)}
    </div>`
  const box = $("dm-pick-list")
  const filterButton = box.querySelector("#dm-pick-filter")
  filterButton.classList.toggle("is-active", pickFilters.size > 0)
  const flip = (value) => {
    if (pickFilters.has(value)) pickFilters.delete(value)
    else pickFilters.add(value)
    renderPick()
  }
  filterButton.onclick = () => openSearchMenu(filterButton, [
    { label: "Выбранные", toggle: true, stayOpen: true, checked: pickFilters.has("selected"), action: () => flip("selected") },
    { label: "Не выбранные", toggle: true, stayOpen: true, checked: pickFilters.has("unselected"), action: () => flip("unselected") },
  ])
  const input = box.querySelector("#dm-pick-search")
  input.oninput = (e) => {
    filters.set("dm-pick-list", e.target.value)
    renderPick()
    const nf = $("dm-pick-list").querySelector("#dm-pick-search")
    nf.focus()
    nf.setSelectionRange(nf.value.length, nf.value.length)
  }
  box.querySelector("#dm-pick-search-clear").onclick = () => {
    filters.delete("dm-pick-list")
    pickFilters.clear()
    renderPick()
    $("dm-pick-list").querySelector("#dm-pick-search").focus()
  }
  $("dm-pick-list").querySelectorAll("input[data-id]").forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.id
      if (cb.checked) {
        if (!draft.upstreams.some((upstream) => upstream.provider === provider && upstream.model === id)) draft.upstreams.push({ provider, model: id })
      } else {
        draft.upstreams = draft.upstreams.filter((upstream) => !(upstream.provider === provider && upstream.model === id))
      }
      renderModelDialog()
    }
  })
  applyPmColumns($("dm-pick-list"))
}

$("m-add").onclick = () => openModelDialog()
const syncOpenCode = async () => {
  const r = await api("/api/opencode-sync", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  flash(!!j.ok, j.ok ? (j.enabled === false ? "Opencode выключен" : `Провайдер и ${j.models} моделей добавлены`) : "Opencode не обновился — смотри вкладку «Логи»")
}
$("opencode-sync").onclick = syncOpenCode
$("dm-cancel").onclick = () => dlgModel.close()
$("dm-delete").onclick = async () => {
  const name = draft?.original
  if (!name) return
  if (!(await askConfirm(`Удалить цепочку «${name}»?`, { title: "Удалить цепочку", okLabel: "Удалить", danger: true }))) return
  delete cfg.models[name]
  save(); renderModels(); renderOpenCode()
  dlgModel.close()
}

$("dm-form").addEventListener("submit", (e) => {
  const name = $("dm-name").value.trim()
  if (!name || !draft.upstreams.length || (cfg.models[name] && name !== draft.original)) {
    e.preventDefault()
    flash(false, !name ? "впиши имя" : !draft.upstreams.length ? "добавь хотя бы одного провайдера в цепочку" : "имя занято")
  }
})
dlgModel.addEventListener("close", () => {
  if (dlgModel.returnValue !== "save") return
  const name = $("dm-name").value.trim()
  cfg.models[name] = { ...(draft.enabled ? {} : { enabled: false }), upstreams: draft.upstreams }
  if (draft.original && draft.original !== name) delete cfg.models[draft.original]
  save(); renderModels(); renderOpenCode()
})
