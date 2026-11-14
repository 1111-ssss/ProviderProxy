// ---------- прямые модели OpenCode ----------

const dlgOpenCodeModel = $("dlg-opencode-model")
let directDraft = null // { provider, models, all, filter, providerFilter }

function openOpenCodeModelDialog(provider = null) {
  const names = Object.keys(cfg.providers)
  const selectedProvider = provider ?? names[0] ?? ""
   const definition = cfg.opencodeModels?.[selectedProvider]
   const current = directModelIds(selectedProvider, definition)
   directDraft = { provider: selectedProvider, models: [...current], all: definition?.all === true, filter: "", providerFilter: "" }
  dlgOpenCodeModel.returnValue = ""
  renderOpenCodeModelDialog()
  dlgOpenCodeModel.showModal()
}

function renderOpenCodeModelDialog() {
  const names = Object.keys(cfg.providers)
  const providerQuery = directDraft.providerFilter.trim().toLowerCase()
  const shownProviders = providerQuery ? names.filter((name) => name.toLowerCase().includes(providerQuery)) : names
  $("dom-provider-result").textContent = providerQuery
    ? `${shownProviders.length} из ${names.length}`
    : `${names.length} ${names.length === 1 ? "провайдер" : "провайдеров"}`
  $("dom-provider-options").innerHTML = shownProviders.length
    ? shownProviders
        .map(
          (name) => `<button type="button" class="provider-option ${name === directDraft.provider ? "active" : ""}" data-provider="${esc(name)}" role="option" aria-selected="${name === directDraft.provider}">
            <strong>${esc(name)}</strong><small>${plural((cfg.providers[name].models ?? []).length, "модель", "модели", "моделей")}</small>
          </button>`,
        )
        .join("")
    : `<span class="muted">${names.length ? "провайдер не найден — измени запрос" : "провайдеров пока нет — добавь их на вкладке «Провайдеры»"}</span>`
  $("dom-provider-current").innerHTML = directDraft.provider ? `<strong>${esc(directDraft.provider)}</strong>` : "<strong>—</strong>"
  $("dom-provider-filter").value = directDraft.providerFilter
  $("dom-provider-filter").oninput = (e) => {
    directDraft.providerFilter = e.target.value
    renderOpenCodeModelDialog()
    const input = $("dom-provider-filter")
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
  $("dom-provider-filter-clear").onclick = () => {
    directDraft.providerFilter = ""
    renderOpenCodeModelDialog()
    $("dom-provider-filter").focus()
  }
  $("dom-provider-options").querySelectorAll("[data-provider]").forEach((button) => {
    button.onclick = () => {
      directDraft.provider = button.dataset.provider
       const definition = cfg.opencodeModels?.[directDraft.provider]
       directDraft.models = directModelIds(directDraft.provider, definition)
       directDraft.all = definition?.all === true
      directDraft.filter = ""
      renderOpenCodeModelDialog()
    }
  })
  const p = cfg.providers[directDraft.provider]
   const all = directModelIds(directDraft.provider, { models: p?.models ?? [], all: true })
   if (directDraft.all) directDraft.models = [...all]
  const filter = directDraft.filter.trim().toLowerCase()
  const ids = all.filter((id) => id.toLowerCase().includes(filter))
  $("dom-count").textContent = `${directDraft.models.length} выбрано из ${all.length}`
  const selectAll = $("dom-select-all")
   selectAll.checked = all.length > 0 && directDraft.all === true
   selectAll.indeterminate = directDraft.all !== true && directDraft.models.length > 0 && directDraft.models.length < all.length
   selectAll.onchange = () => {
     directDraft.all = selectAll.checked
     directDraft.models = selectAll.checked ? [...all] : []
    renderOpenCodeModelDialog()
  }
  $("dom-model-list").innerHTML = ids.length
    ? ids
        .map(
            (id) => `<label class="check"><input type="checkbox" data-id="${esc(id)}" ${directDraft.models.includes(id) ? "checked" : ""}><code>${esc(id)}</code>${isImageModel(directDraft.provider, id) ? imageIcon() : ""}${contextBadge(directDraft.provider, id)}${availabilityBadge(directDraft.provider, id)}</label>`,
        )
        .join("")
    : `<span class="muted">${all.length ? "ничего не найдено" : "у провайдера нет выбранных моделей — добавь их на вкладке «Подключения»"}</span>`
  $("dom-model-list").querySelectorAll("input[data-id]").forEach((cb) => {
    cb.onchange = () => {
       const id = cb.dataset.id
       const i = directDraft.models.indexOf(id)
       directDraft.all = false
      if (cb.checked && i < 0) directDraft.models.push(id)
      if (!cb.checked && i >= 0) directDraft.models.splice(i, 1)
      $("dom-count").textContent = `${directDraft.models.length} выбрано из ${all.length}`
    }
  })
  $("dom-filter").value = directDraft.filter
  $("dom-filter").oninput = (e) => {
    directDraft.filter = e.target.value
    renderOpenCodeModelDialog()
    const input = $("dom-filter")
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
}

$("om-add").onclick = () => openOpenCodeModelDialog()
$("dom-cancel").onclick = () => dlgOpenCodeModel.close()
$("dom-form").addEventListener("submit", (e) => {
  if (!directDraft?.provider || !directDraft.models.length) {
    e.preventDefault()
    flash(false, !directDraft?.provider ? "сначала добавь провайдера" : "выбери хотя бы одну модель")
  }
})
dlgOpenCodeModel.addEventListener("close", () => {
  if (dlgOpenCodeModel.returnValue !== "save" || !directDraft?.provider) return
  cfg.opencodeModels ??= {}
  const prev = cfg.opencodeModels[directDraft.provider] ?? {}
   const next = { ...prev, models: [...new Set(directDraft.models.filter((id) => !isImageModel(directDraft.provider, id)))] }
   if (directDraft.all) next.all = true
   else delete next.all
   cfg.opencodeModels[directDraft.provider] = next
  save(); renderOpencodeModels(); renderOpenCode(); renderProviderModels()
})

