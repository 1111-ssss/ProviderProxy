const dlgModel = $("dlg-model")
let draft = null // { original, enabled, upstreams: [{provider, model}] }
let pickProvider = null // провайдер, выбранный в пикере «или из выбранных моделей провайдера»
let chainProviderFilter = ""

function openModelDialog(name = null) {
  const src = name ? cfg.models[name] : null
  draft = { original: name, enabled: src?.enabled !== false, upstreams: src ? JSON.parse(JSON.stringify(src.upstreams ?? [])) : [] }
  dlgModel.returnValue = ""
  $("dm-title").textContent = name ? `Цепочка proxy/${name}` : "Добавить цепочку"
  $("dm-name").value = name ?? ""
  pickProvider = null
  chainProviderFilter = ""
  filters.delete("dm-pick-list")
  renderModelDialog()
  dlgModel.showModal()
}

function renderModelDialog() {
  const ups = draft.upstreams
  const provNames = Object.keys(cfg.providers)

  $("dm-chain").innerHTML = ups.length
    ? ups
        .map(
          (u, i) => `
          <div class="chain-row" draggable="true" data-chain-index="${i}">
           <span class="step-number" aria-hidden="true" title="Перетащить модель">${i + 1}</span>
          <label class="sr-only" for="dm-provider-${i}">Провайдер, шаг ${i + 1}</label>
          <select id="dm-provider-${i}" data-i="${i}" data-k="provider" aria-label="Провайдер, шаг ${i + 1}">
            ${provNames.map((pn) => `<option ${pn === u.provider ? "selected" : ""}>${esc(pn)}</option>`).join("")}
            ${u.provider && !cfg.providers[u.provider] ? `<option selected>${esc(u.provider)} (удалён)</option>` : ""}
          </select>
          <label class="sr-only" for="dm-model-${i}">ID модели, шаг ${i + 1}</label>
          <input id="dm-model-${i}" data-i="${i}" data-k="model" value="${esc(u.model ?? "")}" placeholder="ID модели у провайдера" aria-label="ID модели, шаг ${i + 1}">
          <div class="row-controls">
            <button class="icon-button" type="button" data-a="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Переместить шаг ${i + 1} выше" title="Выше"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg></button>
            <button class="icon-button" type="button" data-a="down" data-i="${i}" ${i === ups.length - 1 ? "disabled" : ""} aria-label="Переместить шаг ${i + 1} ниже" title="Ниже"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>
             <button class="icon-button danger" type="button" data-a="rm" data-i="${i}" aria-label="Удалить модель ${i + 1}" title="Удалить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg></button>
          </div>
        </div>`,
        )
        .join("")
    : `<p class="muted" style="margin:4px 0">Цепочка пуста — выбери модель ниже или введи ID вручную.</p>`

  $("dm-count").textContent = ups.length ? plural(ups.length, "провайдер", "провайдера", "провайдеров") : "нет провайдеров"

  $("dm-chain").querySelectorAll("select[data-i],input[data-i]").forEach((el) => {
    el.onchange = () => {
      draft.upstreams[+el.dataset.i][el.dataset.k] = el.value.trim()
    }
  })
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

  // Use the same searchable provider picker as the provider-models tab.
  const prefer = pickProvider ?? draft.upstreams.at(-1)?.provider ?? provNames[0]
  if (!pickProvider && prefer) pickProvider = prefer
  const providerQuery = chainProviderFilter.trim().toLowerCase()
  const shownProviders = providerQuery ? provNames.filter((pn) => pn.toLowerCase().includes(providerQuery)) : provNames
  $("dm-provider-result").textContent = providerQuery ? `${shownProviders.length} из ${provNames.length}` : plural(provNames.length, "провайдер", "провайдера", "провайдеров")
  $("dm-provider-options").innerHTML = shownProviders.length
    ? shownProviders
        .map(
          (pn) => `<button type="button" class="provider-option ${pn === pickProvider ? "active" : ""}" data-provider="${esc(pn)}" role="option" aria-selected="${pn === pickProvider}">
            <strong>${esc(pn)}</strong><small>${plural((cfg.providers[pn].models ?? []).length, "модель", "модели", "моделей")}</small>
          </button>`,
        )
        .join("")
    : `<span class="muted">провайдер не найден — измени запрос</span>`
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

$("dm-add").onclick = () => {
  const pn = pickProvider
  const mid = $("dm-add-model").value.trim()
  if (!pn || !mid) return flash(false, !pn ? "сначала выбери провайдера" : "впиши ID модели")
  if (isImageModel(pn, mid)) return flash(false, "image-модели нельзя добавлять в цепочки — используй вкладку «Изображения»")
  draft.upstreams.push({ provider: pn, model: mid })
  $("dm-add-model").value = ""
  renderModelDialog()
}

function renderPick() {
  const pn = pickProvider
  if (!pn) return ($("dm-pick-list").innerHTML = "")
  const allIds = (cfg.providers[pn]?.models ?? []).filter((id) => !isImageModel(pn, id))
  const used = new Set(draft.upstreams.filter((u) => u.provider === pn).map((u) => u.model))
  const ids = allIds.filter((id) => !used.has(id))
  if (!allIds.length)
    return ($("dm-pick-list").innerHTML = `<span class="muted">у «${esc(pn)}» нет доступных для цепочки моделей — image-модели добавляются только на вкладке «Изображения»</span>`)
  if (!ids.length)
    return ($("dm-pick-list").innerHTML = `<span class="muted">Все модели провайдера «${esc(pn)}» уже добавлены в цепочку.</span>`)
  renderChips("dm-pick-list", pn, ids, (id) => {
    if (draft.upstreams.some((u) => u.provider === pn && u.model === id)) return flash(false, "уже в цепочке")
    draft.upstreams.push({ provider: pn, model: id })
    renderModelDialog()
  }, cfg.providers[pn]?.modelInfo ?? {})
}

$("m-add").onclick = () => openModelDialog()
const syncOpenCode = async () => {
  const r = await api("/api/opencode-sync", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  flash(!!j.ok, j.ok ? (j.enabled === false ? "Интеграция выключена" : `Провайдер и ${j.models} моделей добавлены`) : "Интеграция не обновилась — смотри вкладку «Логи»")
}
$("opencode-sync").onclick = syncOpenCode
$("dm-cancel").onclick = () => dlgModel.close()

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

