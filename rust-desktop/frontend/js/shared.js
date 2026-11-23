// Shared UI pieces. Connections, the direct-model dialog and the chain picker
// must look and behave the same, so they render through these.

/// Model cards: tick, id, badges (image icon, ctx, "не найдена").
function modelCardsHtml(provider, ids, { checked = () => false, disabled = false, settings = false } = {}) {
  return `<div class="pm-grid">${ids.map((id) => `<div class="provider-model-card">
    <label class="provider-model-card-main">
      <input type="checkbox" data-id="${esc(id)}" ${checked(id) ? "checked" : ""}${disabled ? " disabled" : ""}>
      <span class="provider-model-card-body"><code data-tip="${esc(id)}">${esc(id)}</code><span class="provider-model-card-meta">${isImageModel(provider, id) ? imageIcon() : ""}${contextBadge(provider, id)}${availabilityBadge(provider, id)}</span></span>
    </label>${settings ? `<button type="button" class="model-settings-button" data-model-settings="${esc(id)}" aria-label="Параметры модели ${esc(id)}" data-tip="Параметры модели">⋮</button>` : ""}
  </div>`).join("")}</div>`
}

/// Provider buttons for a picker pane.
function providerOptionsHtml(names, current) {
  return names
    .map((name) => `<button type="button" class="provider-option ${name === current ? "active" : ""}" data-provider="${esc(name)}" role="option" aria-selected="${name === current}"><strong>${esc(name)}</strong></button>`)
    .join("")
}

/// Search field with the shared clear button and, optionally, a filter button.
function searchFieldHtml(inputId, clearId, placeholder, value = "", filterId = "") {
  const filter = filterId
    ? `<button id="${filterId}" class="search-filter" type="button" aria-label="Фильтр моделей" data-tip="Фильтр" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.5 8v5.5L10 21v-8Z"></path></svg></button>`
    : ""
  return `<label class="search-field"><span class="sr-only">${esc(placeholder)}</span><input id="${inputId}" placeholder="${esc(placeholder)}" autocomplete="off" value="${esc(value)}">${filter}<button id="${clearId}" class="search-clear" type="button" aria-label="Очистить поиск" data-tip="Очистить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button></label>`
}

async function fetchProviderModels(name) {
  const p = cfg.providers[name]
  const r = await api("/api/provider-models", { method: "POST", body: JSON.stringify({ provider: name }) })
  const j = await r.json().catch(() => ({}))
  return r.ok
    ? { provider: name, ids: j.models ?? [], details: j.details ?? {} }
    : { provider: name, ids: [], details: {}, error: apiErrorMessage(j, `HTTP ${r.status}`) }
}

