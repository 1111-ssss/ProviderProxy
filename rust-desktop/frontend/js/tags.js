// Custom tags for chains and direct models. One global registry (`cfg.tags`)
// so renaming a tag fixes every reference in one place, and the chip colour is
// derived from the name — a colour field per tag would be one more thing to
// validate for no visible gain.

/// Stable colour for a tag name. Same name, same colour, in every card and chip.
function tagColor(name) {
  const palette = ["#6f99ed", "#c894f5", "#5fcf96", "#d8b25c", "#ef8f8f", "#5fc7d8", "#b3c95f", "#e39ac9"]
  let hash = 0
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) % 1_000_003
  return palette[hash % palette.length]
}

/// Tags as chips. Kept out of the card markup so every surface looks the same.
const tagChipsHtml = (tags) =>
  (tags ?? [])
    .filter(Boolean)
    .map((tag) => `<span class="tag-chip" style="--tag-color:${tagColor(tag)}">${esc(tag)}</span>`)
    .join("")

/// AND with the other filters, OR inside the tag group: picking two tags shows
/// entries that carry either one.
const tagFilterMatches = (tags, selected) =>
  !selected?.size || (tags ?? []).some((tag) => selected.has(tag))

function tagRegistryNames() {
  return [...new Set(cfg.tags ?? [])].sort((a, b) => a.localeCompare(b, "ru"))
}

/// Where a tag lives: chains and direct models are the only tagged things.
function tagHolders() {
  return [
    ...Object.values(cfg.models ?? {}),
    ...Object.values(cfg.opencodeModels ?? {}),
  ]
}

/// Replace the registry in one pass. Renaming rewrites every reference and
/// dropping removes them, so a saved config can never point at a missing tag.
function applyTagRegistry(nextNames, config = cfg) {
  const previous = [...new Set(config.tags ?? [])]
  const next = [...new Set(nextNames.map((name) => String(name).trim()).filter(Boolean))]
  const held = [
    ...Object.values(config.models ?? {}),
    ...Object.values(config.opencodeModels ?? {}),
  ]
  for (const holder of held) {
    if (!Array.isArray(holder.tags)) continue
    const mapped = holder.tags.map((tag) => {
      const index = previous.indexOf(tag)
      return index >= 0 && index < next.length ? next[index] : tag
    })
    holder.tags = [...new Set(mapped.filter((tag) => next.includes(tag)))]
    if (!holder.tags.length) delete holder.tags
  }
  if (next.length) config.tags = next
  else delete config.tags
  return config
}

// Search state per picker, so toggling a chip (which rebuilds the dialog) does
// not close the field or drop what is typed.
const tagPickerState = new Map()
const tagPickerStateOf = (id) => {
  if (!tagPickerState.has(id)) tagPickerState.set(id, { query: "", search: false })
  return tagPickerState.get(id)
}
const TAG_SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg>'
const TAG_EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>'

/// One row: the chips that fit, then search and the registry button. Picked
/// tags come first, so a selection is never hidden by the fit.
function tagPickerHtml(selected, id = "") {
  const picked = new Set(selected ?? [])
  const names = tagRegistryNames()
  const ordered = [...names.filter((tag) => picked.has(tag)), ...names.filter((tag) => !picked.has(tag))]
  const chips = ordered
    .map((tag) => `<button type="button" class="tag-chip tag-toggle${picked.has(tag) ? " is-on" : ""}" data-tag="${esc(tag)}" aria-pressed="${picked.has(tag)}" style="--tag-color:${tagColor(tag)}">${esc(tag)}</button>`)
    .join("")
  const state = tagPickerStateOf(id)
  return `<span class="tag-picker-list">${chips || `<span class="muted">тегов пока нет</span>`}<span class="tag-picker-empty" hidden>ничего не найдено</span></span>
    <span class="tag-picker-search${state.search ? " is-open" : ""}"><input type="search" data-tag-search aria-label="Поиск тегов" placeholder="Поиск" value="${esc(state.query)}" autocomplete="off"></span>
    <button type="button" class="icon-action tag-picker-icon" data-tag-search-toggle aria-pressed="${state.search}" aria-label="${state.search ? "Скрыть поиск" : "Поиск тегов"}" data-tip="${state.search ? "Скрыть поиск" : "Поиск"}">${TAG_SEARCH_ICON}</button>
    <button type="button" class="icon-action tag-picker-icon" data-tag-manage aria-label="Изменить теги" data-tip="Добавить или переименовать">${TAG_EDIT_ICON}</button>`
}

const tagPickerObservers = new Map()

/// Hide the chips past the field width: the dialog keeps one row however many
/// tags the registry holds, and the search finds the ones that do not fit.
function syncTagPicker(id) {
  const box = $(id)
  const list = box?.querySelector(".tag-picker-list")
  if (!list) return
  const query = tagPickerStateOf(id).query.trim().toLowerCase()
  const chips = [...list.querySelectorAll(".tag-toggle")]
  let room = list.clientWidth
  for (const chip of chips) chip.hidden = false
  // A hidden dialog reports no width; keep everything visible until it opens.
  if (!room) return
  let used = 0
  let shown = 0
  for (const chip of chips) {
    const matches = !query || chip.dataset.tag.toLowerCase().includes(query)
    if (!matches || used + chip.offsetWidth > room) {
      chip.hidden = true
      continue
    }
    used += chip.offsetWidth + 6
    shown += 1
  }
  const empty = list.querySelector(".tag-picker-empty")
  if (empty) empty.hidden = shown > 0
}

/// Wire a rendered picker: chips toggle the local draft, the search narrows the
/// row, and the last button opens the registry.
function wireTagPicker(containerId, getSelected, setSelected, rerender) {
  const box = $(containerId)
  box.querySelectorAll(".tag-toggle").forEach((button) => {
    button.onclick = () => {
      const next = new Set(getSelected())
      const tag = button.dataset.tag
      next.has(tag) ? next.delete(tag) : next.add(tag)
      setSelected([...next])
      rerender()
    }
  })
  box.querySelector("[data-tag-manage]").onclick = () => openTagRegistry(rerender)
  const state = tagPickerStateOf(containerId)
  const input = box.querySelector("[data-tag-search]")
  input.oninput = () => {
    state.query = input.value
    syncTagPicker(containerId)
  }
  // The picker lives in a dialog form; Enter must not submit it while searching.
  input.onkeydown = (event) => {
    if (event.key === "Enter") event.preventDefault()
  }
  box.querySelector("[data-tag-search-toggle]").onclick = () => {
    state.search = !state.search
    if (!state.search) state.query = ""
    rerender()
    if (state.search) $(containerId).querySelector("[data-tag-search]")?.focus()
  }
  // The list is rebuilt on every render, so the observer follows the new node;
  // watching the picker instead would miss the search field taking width away.
  tagPickerObservers.get(containerId)?.disconnect()
  const observer = new ResizeObserver(() => syncTagPicker(containerId))
  observer.observe(box.querySelector(".tag-picker-list"))
  tagPickerObservers.set(containerId, observer)
  syncTagPicker(containerId)
}

// --- Filter flyout with tags ------------------------------------------------
// Same shape as the log filter: tabs on top, the list below, paging at the
// bottom. The tags tab edits the registry as well as filtering on it.

const TAG_FACET_PAGE_SIZE = 6

function openTagFilterMenu(anchor, { checks = [], checked = () => false, tagSet, onChecksChange, onTagsChange, rerender }) {
  let view = "filter"
  let page = 0
  let query = ""
  let searchOpen = false
  const refresh = () => {
    render(searchMenu)
    positionSearchMenu(anchor)
  }
  const render = (menu) => {
    const tags = tagRegistryNames()
    const isTags = view === "tags"
    const needle = query.trim().toLowerCase()
    const entries = needle ? tags.filter((tag) => tag.toLowerCase().includes(needle)) : tags
    const pages = Math.max(1, Math.ceil(entries.length / TAG_FACET_PAGE_SIZE))
    if (page > pages - 1) page = pages - 1
    const shown = isTags ? entries.slice(page * TAG_FACET_PAGE_SIZE, (page + 1) * TAG_FACET_PAGE_SIZE) : entries
    menu.className = "search-menu log-filter-menu"
    menu.innerHTML = `<div class="log-filter-tabs">
        <button type="button" data-view="filter" class="${view === "filter" ? "active" : ""}" aria-pressed="${view === "filter"}">Фильтр</button>
        <button type="button" data-view="tags" class="${view === "tags" ? "active" : ""}" aria-pressed="${view === "tags"}">Теги</button>
      </div>
      <div class="log-facet-options">${
        isTags
          ? shown.length
            ? shown.map((tag) => `<label class="log-facet-option" data-tip="${esc(tag)}"><input type="checkbox" value="${esc(tag)}" ${tagSet.has(tag) ? "checked" : ""}><span class="tag-chip" style="--tag-color:${tagColor(tag)}">${esc(tag)}</span></label>`).join("")
            : `<div class="empty-inline">${needle ? "ничего не найдено" : "тегов пока нет"}</div>`
          : checks.map(({ value, label }) => `<label class="log-facet-option"><input type="checkbox" value="${esc(value)}" ${checked(value) ? "checked" : ""}><span>${esc(label)}</span></label>`).join("")
      }</div>
      ${isTags
        ? `<div class="log-facet-footer is-tags">
            <button type="button" data-facet-page="-1" aria-label="Предыдущая страница" ${page === 0 ? "disabled" : ""}>‹</button>
            <button type="button" data-tag-search-toggle aria-label="${searchOpen ? "Скрыть поиск" : "Поиск тегов"}" data-tip="${searchOpen ? "Скрыть поиск" : "Поиск"}" aria-pressed="${searchOpen}">${TAG_SEARCH_ICON}</button>
            <button type="button" data-tag-manage aria-label="Изменить теги" data-tip="Добавить или переименовать">${TAG_EDIT_ICON}</button>
            <button type="button" data-facet-page="1" aria-label="Следующая страница" ${page >= pages - 1 ? "disabled" : ""}>›</button>
          </div>
          ${searchOpen ? `<input class="log-facet-search" type="search" aria-label="Поиск тегов" placeholder="Поиск" value="${esc(query)}" autocomplete="off">` : ""}`
        : ""}`
    menu.querySelectorAll("[data-view]").forEach((button) => (button.onclick = () => {
      view = button.dataset.view
      page = 0
      query = ""
      searchOpen = false
      refresh()
    }))
    if (!isTags) {
      menu.querySelectorAll("input[value]").forEach((box) => (box.onchange = () => {
        onChecksChange(box.value)
        refresh()
      }))
      return
    }
    menu.querySelectorAll("input[value]").forEach((box) => (box.onchange = () => {
      onTagsChange(box.value)
      refresh()
    }))
    menu.querySelectorAll("[data-facet-page]").forEach((button) => (button.onclick = () => {
      page += Number(button.dataset.facetPage)
      refresh()
    }))
    menu.querySelector("[data-tag-search-toggle]").onclick = () => {
      searchOpen = !searchOpen
      if (!searchOpen) query = ""
      page = 0
      refresh()
      if (searchOpen) menu.querySelector(".log-facet-search")?.focus()
    }
    menu.querySelector(".log-facet-search")?.addEventListener("input", (event) => {
      query = event.target.value
      page = 0
      refresh()
      const input = searchMenu.querySelector(".log-facet-search")
      input?.focus()
      input?.setSelectionRange(input.value.length, input.value.length)
    })
    // The registry may add tags, so rebuild the list and the underlying cards.
    menu.querySelector("[data-tag-manage]").onclick = () => openTagRegistry(() => {
      refresh()
      rerender?.()
    })
  }
  openSearchMenuContent(anchor, render)
}


// --- Tag registry dialog ----------------------------------------------------
// Editing happens on a draft copy: cancelling must not half-apply a rename.
const dlgTags = $("dlg-tags")
let tagDraft = []
let tagOnSaved = null
let tagRegistryPage = 0
let tagRegistryQuery = ""
const TAG_REGISTRY_PAGE_SIZE = 8

function openTagRegistry(onSaved = null) {
  tagDraft = tagRegistryNames()
  tagOnSaved = onSaved
  tagRegistryPage = 0
  tagRegistryQuery = ""
  dlgTags.returnValue = ""
  $("tags-new").value = ""
  $("tags-search").value = ""
  renderTagRegistry()
  dlgTags.showModal()
}

function renderTagRegistry() {
  const list = $("tags-list")
  const needle = tagRegistryQuery.trim().toLowerCase()
  // Rows keep their index into the draft: the search only hides rows, so a
  // rename or a delete still edits the tag the user sees.
  const rows = tagDraft
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => !needle || name.toLowerCase().includes(needle))
  const pages = Math.max(1, Math.ceil(rows.length / TAG_REGISTRY_PAGE_SIZE))
  if (tagRegistryPage > pages - 1) tagRegistryPage = pages - 1
  const shown = rows.slice(tagRegistryPage * TAG_REGISTRY_PAGE_SIZE, (tagRegistryPage + 1) * TAG_REGISTRY_PAGE_SIZE)
  list.innerHTML = shown.length
    ? shown
        .map(({ name, index }) => `<div class="tag-registry-row" data-tag-index="${index}">
            <span class="tag-chip" style="--tag-color:${tagColor(name)}" data-tip="${esc(name)}">${esc(name || "-")}</span>
            <input class="tag-registry-input" value="${esc(name)}" aria-label="Имя тега" data-new autocomplete="off">
            <button type="button" class="icon-action danger" data-remove aria-label="Удалить тег ${esc(name)}" data-tip="Удалить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg></button>
          </div>`)
        .join("")
    : emptyInlineHtml(needle ? "ничего не найдено" : "тегов пока нет")
  const pager = $("tags-pager")
  pager.hidden = pages <= 1
  pager.innerHTML = `<button type="button" data-tags-page="-1" aria-label="Предыдущая страница" ${tagRegistryPage === 0 ? "disabled" : ""}>‹</button><span class="muted">${tagRegistryPage + 1} / ${pages}</span><button type="button" data-tags-page="1" aria-label="Следующая страница" ${tagRegistryPage >= pages - 1 ? "disabled" : ""}>›</button>`
  pager.querySelectorAll("[data-tags-page]").forEach((button) => (button.onclick = () => {
    tagRegistryPage += Number(button.dataset.tagsPage)
    renderTagRegistry()
  }))
  for (const row of list.querySelectorAll(".tag-registry-row")) {
    const index = Number(row.dataset.tagIndex)
    // Live-update the chip while typing so the colour change is visible.
    const chip = row.querySelector(".tag-chip")
    row.querySelector(".tag-registry-input").oninput = (event) => {
      tagDraft[index] = event.target.value
      chip.textContent = event.target.value || "-"
      chip.style.setProperty("--tag-color", tagColor(event.target.value))
    }
    row.querySelector("[data-remove]").onclick = () => {
      tagDraft.splice(index, 1)
      renderTagRegistry()
    }
  }
}

function addTagFromField() {
  const input = $("tags-new")
  const name = input.value.trim()
  if (!name) return
  if (!tagDraft.includes(name)) tagDraft.push(name)
  input.value = ""
  renderTagRegistry()
  $("tags-new").focus()
}

$("tags-add").onclick = addTagFromField
$("tags-new").onkeydown = (event) => {
  if (event.key !== "Enter") return
  event.preventDefault() // Enter adds a tag instead of submitting the dialog
  addTagFromField()
}
// Typing in the search must not submit the dialog form either.
$("tags-search").oninput = (event) => {
  tagRegistryQuery = event.target.value
  tagRegistryPage = 0
  renderTagRegistry()
}
$("tags-search").onkeydown = (event) => {
  if (event.key === "Enter") event.preventDefault()
}
$("tags-cancel").onclick = () => dlgTags.close()
dlgTags.addEventListener("close", () => {
  if (dlgTags.returnValue !== "save") return
  applyTagRegistry(tagDraft)
  save()
  // Every surface that draws tags (cards, filters, open dialogs) rebuilds.
  renderAll()
  tagOnSaved?.()
  tagOnSaved = null
})

