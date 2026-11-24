// Shared UI pieces. Connections, the direct-model dialog and the chain picker
// must look and behave the same, so they render through these.

/// Model cards: tick, id, badges ("не найдена", image icon, ctx).
function modelCardsHtml(provider, ids, { checked = () => false, disabled = false, settings = false } = {}) {
  return `<div class="pm-grid">${ids.map((id) => `<div class="provider-model-card">
    <label class="provider-model-card-main">
      <input type="checkbox" data-id="${esc(id)}" ${checked(id) ? "checked" : ""}${disabled ? " disabled" : ""}>
      <span class="provider-model-card-body"><code data-tip="${esc(id)}">${esc(id)}</code><span class="provider-model-card-meta">${availabilityBadge(provider, id)}${isImageModel(provider, id) ? imageIcon() : ""}${contextBadge(provider, id)}</span></span>
    </label>${settings ? `<button type="button" class="model-settings-button" data-model-settings="${esc(id)}" aria-label="Параметры модели ${esc(id)}" data-tip="Параметры модели">⋮</button>` : ""}
  </div>`).join("")}</div>`
}

/// Provider buttons for a picker pane. `counts` (Connections only) shows how
/// many models of that provider are selected.
function providerOptionsHtml(names, current, counts = null) {
  return names
    .map((name) => `<button type="button" class="provider-option ${name === current ? "active" : ""}" data-provider="${esc(name)}" role="option" aria-selected="${name === current}"><strong>${esc(name)}</strong>${counts ? `<small>${counts[name] ?? 0}</small>` : ""}</button>`)
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
  const r = await api("/api/provider-models", { method: "POST", body: JSON.stringify({ provider: name }) })
  const j = await r.json().catch(() => ({}))
  return r.ok
    ? { provider: name, ids: j.models ?? [], details: j.details ?? {} }
    : { provider: name, ids: [], details: {}, error: apiErrorMessage(j, `HTTP ${r.status}`) }
}

// --- Model card columns -----------------------------------------------------
// One place decides how many cards fit in a row: Connections, the model dialog
// and the chain picker all render the same card, so they must break lines the
// same way.

function pmColumnCount(available, cardWidth, gap = 8) {
  return Math.max(1, Math.min(4, Math.floor((available + gap) / (cardWidth + gap))))
}

let pmColumnsObservers = new WeakMap()

/// Measure the natural width of rendered cards, including labels and badges.
function measureCardWidth(box, selector, minWidth = 0) {
  const probe = document.createElement("div")
  probe.className = "provider-model-card"
  probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;width:max-content"
  document.body.append(probe)
  let widest = minWidth
  for (const card of box.querySelectorAll(selector)) {
    probe.replaceChildren(...[...card.childNodes].map((node) => node.cloneNode(true)))
    widest = Math.max(widest, Math.ceil(probe.getBoundingClientRect().width))
  }
  probe.remove()
  return widest
}

/// Model-card columns: an overlong label gets a single column instead of
/// squeezing several cards into unreadable slivers.
function applyPmColumns(box) {
  const needed = measureCardWidth(box, ".provider-model-card", 210)
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
  let observer = pmColumnsObservers.get(grid)
  if (!observer) {
    // Deferred: re-laying out inside the callback makes WebKit report a
    // ResizeObserver loop error, which the global handler would show as a
    // page failure.
    observer = new ResizeObserver(() => requestAnimationFrame(fit))
    pmColumnsObservers.set(grid, observer)
    observer.observe(grid)
  }
}

/// The chain editor uses a separate row layout, but shares the same sizing
/// module: try two columns, then collapse to one if a model id gets clipped.
function applyChainColumns(box) {
  const fit = () => {
    const available = box.clientWidth
    if (!available) return
    const rows = [...box.querySelectorAll(".chain-row")]
    const cols = Math.max(1, Math.min(2, Math.floor((available + 8) / 338)))
    const rowsPerColumn = Math.max(1, Math.ceil(rows.length / cols))
    box.style.setProperty("--chain-cols", cols)
    box.style.setProperty("--chain-rows", rowsPerColumn)
    // Wait for the chosen grid width to apply, then detect actual text clipping.
    requestAnimationFrame(() => {
      const clipped = [...box.querySelectorAll(".chain-row")].some((row) => {
        const name = row.querySelector(".chain-model-label code")
        return name && name.scrollWidth > name.clientWidth + 1
      })
      const finalCols = clipped ? 1 : cols
      const finalRows = Math.max(1, Math.ceil(rows.length / finalCols))
      if (box.style.getPropertyValue("--chain-cols") !== String(finalCols)) box.style.setProperty("--chain-cols", finalCols)
      if (box.style.getPropertyValue("--chain-rows") !== String(finalRows)) box.style.setProperty("--chain-rows", finalRows)
    })
  }
  fit()
  let observer = pmColumnsObservers.get(box)
  if (!observer) {
    observer = new ResizeObserver(() => requestAnimationFrame(fit))
    pmColumnsObservers.set(box, observer)
    observer.observe(box)
  }
}

