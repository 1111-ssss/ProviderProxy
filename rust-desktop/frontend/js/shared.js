// Filterable chips list: header names the provider and counts matches, so a huge
// aggregated catalog (OpenRouter & co) can't be mistaken for "all providers".
function renderChips(containerId, provider, ids, onAdd, details = {}) {
  const box = $(containerId)
  const ft = filters.get(containerId) ?? ""
  const shown = ids.filter((id) => id.toLowerCase().includes(ft.toLowerCase()))
  box.innerHTML = `
    <div class="row" style="width:100%">
      <span class="muted">провайдер «${esc(provider)}» — ${shown.length} из ${plural(ids.length, "модели", "моделей", "моделей")}</span>
      <input data-role="filter" placeholder="фильтр по имени…" style="flex:1;min-width:120px" value="${esc(ft)}">
    </div>
    <div class="fetched" style="margin-top:6px">
       ${shown.length
          ? shown.map((id) => { const context = contextLabel({ ...(details[id] ?? {}), ...(modelDetails(provider, id) ?? {}) }); return `<span class="chip"><code>${esc(id)}</code>${isImageModel(provider, id) ? imageIcon() : ""}${context ? `<span class="model-context">ctx ${esc(context)}</span>` : ""}<button type="button" data-id="${esc(id)}" aria-label="Добавить модель ${esc(id)}" title="Добавить в цепочку">＋</button></span>` }).join("")
        : `<span class="muted">ничего не найдено</span>`}
    </div>`
  const f = box.querySelector('[data-role="filter"]')
  f.oninput = (e) => {
    filters.set(containerId, e.target.value)
    renderChips(containerId, provider, ids, onAdd, details)
    const nf = $(containerId).querySelector('[data-role="filter"]')
    nf.focus()
    nf.setSelectionRange(nf.value.length, nf.value.length)
  }
  box.querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => onAdd(b.dataset.id)))
}

async function fetchProviderModels(name) {
  const p = cfg.providers[name]
  const r = await api("/api/provider-models", { method: "POST", body: JSON.stringify({ provider: name }) })
  const j = await r.json().catch(() => ({}))
  return r.ok
    ? { provider: name, ids: j.models ?? [], details: j.details ?? {} }
    : { provider: name, ids: [], details: {}, error: apiErrorMessage(j, `HTTP ${r.status}`) }
}

