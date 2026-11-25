const dlgOpenCodeModel = $("dlg-opencode-model")
let directDraft = null // { provider, models, all, filter, providerFilter }

function openOpenCodeModelDialog(provider = null) {
  const names = Object.keys(cfg.providers)
  const selectedProvider = provider ?? names[0] ?? ""
   const definition = cfg.opencodeModels?.[selectedProvider]
   const current = directModelIds(selectedProvider, definition)
  directDraft = { provider: selectedProvider, models: [...current], all: definition?.all === true, filter: "", providerFilter: "", filters: new Set(), editMode: Boolean(provider), tags: [...(definition?.tags ?? [])] }
  dlgOpenCodeModel.returnValue = ""
  tagPickerState.delete("dom-tags")
  $("dom-delete").hidden = !directDraft.editMode || !cfg.opencodeModels?.[selectedProvider]
  renderOpenCodeModelDialog()
  dlgOpenCodeModel.showModal()
}

function renderOpenCodeModelDialog() {
  const names = Object.keys(cfg.providers)
  $("dom-tags").innerHTML = tagPickerHtml(directDraft.tags, "dom-tags")
  wireTagPicker("dom-tags", () => directDraft.tags, (tags) => (directDraft.tags = tags), renderOpenCodeModelDialog)
  const providerQuery = directDraft.providerFilter.trim().toLowerCase()
  const shownProviders = providerQuery ? names.filter((name) => name.toLowerCase().includes(providerQuery)) : names
  $("dom-provider-options").innerHTML = shownProviders.length
    ? providerOptionsHtml(shownProviders, directDraft.provider)
    : emptyInlineHtml(names.length ? "ничего не найдено" : "провайдеров пока нет — добавь их на вкладке «Провайдеры»")
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
      $("dom-delete").hidden = !directDraft.editMode || !definition
      renderOpenCodeModelDialog()
    }
  })

  const provider = cfg.providers[directDraft.provider]
  const all = directModelIds(directDraft.provider, { models: provider?.models ?? [], all: true })
  if (directDraft.all) directDraft.models = [...all]
  const filter = directDraft.filter.trim().toLowerCase()
  const ids = all.filter((id) => {
    if (!id.toLowerCase().includes(filter)) return false
    // Both boxes on means "either", i.e. no restriction.
    const picked = directDraft.models.includes(id)
    if (directDraft.filters.has("selected") && !directDraft.filters.has("unselected") && !picked) return false
    if (directDraft.filters.has("unselected") && !directDraft.filters.has("selected") && picked) return false
    return true
  })
  syncFilterButton("dom-filter-tick", directDraft.filters)
  $("dom-provider-current").innerHTML = `<strong>${esc(directDraft.provider || "-")}</strong>`
  $("dom-model-list").innerHTML = ids.length
    ? modelCardsHtml(directDraft.provider, ids, { checked: (id) => directDraft.models.includes(id) })
    : emptyInlineHtml(all.length ? "ничего не найдено" : "у провайдера нет выбранных моделей — добавь их на вкладке «Подключения»")
  $("dom-model-list").querySelectorAll("input[data-id]").forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.id
      const index = directDraft.models.indexOf(id)
      directDraft.all = false
      if (cb.checked && index < 0) directDraft.models.push(id)
      if (!cb.checked && index >= 0) directDraft.models.splice(index, 1)
    }
  })
  applyPmColumns($("dom-model-list"))
  $("dom-filter").value = directDraft.filter
  $("dom-filter").oninput = (e) => {
    directDraft.filter = e.target.value
    renderOpenCodeModelDialog()
    const input = $("dom-filter")
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
  $("dom-filter-clear").onclick = () => {
    directDraft.filter = ""
    directDraft.filters.clear()
    renderOpenCodeModelDialog()
    $("dom-filter").focus()
  }
  $("dom-filter-tick").onclick = () => openSearchMenu($("dom-filter-tick"), [
    { label: "Выбранные", toggle: true, stayOpen: true, checked: directDraft.filters.has("selected"), action: () => { toggleFilter("dom-filter-tick", directDraft.filters, "selected"); renderOpenCodeModelDialog() } },
    { label: "Не выбранные", toggle: true, stayOpen: true, checked: directDraft.filters.has("unselected"), action: () => { toggleFilter("dom-filter-tick", directDraft.filters, "unselected"); renderOpenCodeModelDialog() } },
  ])
  $("dom-filter-menu").onclick = () => openSearchMenu($("dom-filter-menu"), [
    // Auto mode follows the provider catalog, so it is a switch, not an action.
    { label: "Выбрать все доступные", toggle: true, stayOpen: true, checked: directDraft.all, action: (on) => {
      directDraft.all = on
      directDraft.models = on ? all.filter((id) => cfg.providers[directDraft.provider]?.modelAvailability?.[id]?.available !== false) : []
      renderOpenCodeModelDialog()
    } },
    { label: "Выбрать все", action: () => {
      directDraft.models = [...all]
      directDraft.all = false
      renderOpenCodeModelDialog()
    } },
    { label: "Снять выбор", action: () => { directDraft.models = []; directDraft.all = false; renderOpenCodeModelDialog() } },
  ])
}

$("om-add").onclick = () => openOpenCodeModelDialog()
$("dom-cancel").onclick = () => dlgOpenCodeModel.close()
$("dom-delete").onclick = async () => {
  const provider = directDraft?.provider
  if (!provider || !cfg.opencodeModels?.[provider]) return
  if (!(await askConfirm(`Удалить прямые модели провайдера «${provider}»?`, { title: "Удалить модели", okLabel: "Удалить", danger: true }))) return
  delete cfg.opencodeModels[provider]
  save(); renderOpencodeModels(); renderOpenCode(); renderProviderModels()
  dlgOpenCodeModel.close()
}
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
   // Tags stay with the provider entry; an empty pick removes the field.
   const tags = directDraft.tags?.length ? [...new Set(directDraft.tags)] : []
   if (tags.length) next.tags = tags
   else delete next.tags
   cfg.opencodeModels[directDraft.provider] = next
  save(); renderOpencodeModels(); renderOpenCode(); renderProviderModels()
})
