const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
// Russian counts need three forms: 1 модель, 2 модели, 5 моделей.
const plural = (n, one, few, many) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 > 1 && n % 10 < 5 && (n % 100 < 10 || n % 100 > 20) ? few : many}`
const openUrl = (u) => window.open(/^https?:\/\//.test(u) ? u : "https://" + u, "_blank")

// The desktop window is undecorated (see main.rs), so the page draws the caption
// bar and these buttons are its only window controls. The flag is set here and
// not by a Tauri init script: on Windows that script runs before <html> exists,
// threw on documentElement, and the buttons stayed hidden. A plain browser has
// no app window, so it keeps its own frame and hides the buttons.
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.()
if (appWindow) {
  document.documentElement.dataset.frame = "custom"
  $("titlebar-minimize").onclick = () => appWindow.minimize()
  $("titlebar-maximize").onclick = () => appWindow.toggleMaximize()
  $("titlebar-close").onclick = () => appWindow.close()
  // Swap the maximize glyph for "restore" and keep the label honest.
  const syncFrameState = async () => {
    const maximized = await appWindow.isMaximized()
    document.body.classList.toggle("is-maximized", maximized)
    const label = maximized ? "Восстановить окно" : "Развернуть окно"
    $("titlebar-maximize").setAttribute("aria-label", label)
    $("titlebar-maximize").dataset.tip = label
  }
  appWindow.onResized(syncFrameState)
  syncFrameState()
}

// The settings cards scroll, so the "?" hint is a fixed layer placed next to
// the button and clamped to the viewport. It opens only for the button itself:
// hovering the label used to cover the input and block typing.
const fieldHint = $("field-hint")
let hintButton = null
let hintPinned = false
let hintDeadline = 0
let hintTimer = 0
function showFieldHint(button, html) {
  const hint = html ?? button?.dataset.hint ?? button?.dataset.tip
  if (!hint) return
  hintButton = button
  if (html) fieldHint.innerHTML = html
  else fieldHint.textContent = hint
  fieldHint.hidden = false
  // A modal dialog paints in the top layer, above any page-level layer, so the
  // hint has to live inside the dialog that owns the button.
  const host = button.closest("dialog") ?? document.body
  if (fieldHint.parentElement !== host) host.append(fieldHint)
  const anchor = button.getBoundingClientRect()
  const box = fieldHint.getBoundingClientRect()
  const margin = 8
  // Above, then below, and only then beside. Placed beside, a hint on a button
  // in a toolbar covered the neighbouring control ("Очистить" printed on top of
  // "Добавить"); above or below the button it never sits on another control.
  const centered = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - margin))
  const above = anchor.top - box.height - 8
  const below = anchor.bottom + 8
  let top
  let left = centered
  if (above >= margin) {
    top = above
  } else if (below + box.height <= window.innerHeight - margin) {
    top = below
  } else {
    // No vertical room (a short window): fall back to the side of the button.
    left = anchor.right + 8
    if (left + box.width > window.innerWidth - margin) left = anchor.left - box.width - 8
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin))
    top = Math.max(margin, Math.min(anchor.top + anchor.height / 2 - box.height / 2, window.innerHeight - box.height - margin))
  }
  fieldHint.style.top = `${top}px`
  fieldHint.style.left = `${left}px`
}
function hideFieldHint() {
  clearTimeout(hintTimer)
  hintTimer = 0
  hintPinned = false
  hintDeadline = 0
  const button = hintButton
  hintButton = null
  fieldHint.hidden = true
  // A click leaves the button focused; without this its accent ring outlives
  // the hint it opened. The window may already have lost focus, where the
  // button no longer reports :focus, so blur it unconditionally.
  button?.blur()
}
// A click holds the hint for five seconds. The countdown pauses while the
// pointer rests on the hint or its button, and resumes from where it stopped.
function pinFieldHint(button) {
  showFieldHint(button)
  hintPinned = true
  hintDeadline = Date.now() + 5000
  armHintTimer()
}
function armHintTimer() {
  clearTimeout(hintTimer)
  hintTimer = 0
  if (!hintDeadline) return
  hintTimer = setTimeout(hideFieldHint, Math.max(0, hintDeadline - Date.now()))
}
function holdFieldHint(inside) {
  if (!hintPinned) return
  if (inside) {
    clearTimeout(hintTimer)
    hintTimer = 0
  } else armHintTimer()
}
const overHintArea = (node) => Boolean(node?.closest?.(".field-help, [data-tip], #field-hint"))
// A session name is long and gets truncated, so hovering shows it whole and a
// click copies it. The copy uses the clipboard API and falls back to a hidden
// textarea, because the desktop webview may not expose navigator.clipboard.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  }
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest?.("[data-session-copy]")
  if (!target) return
  const text = target.dataset.sessionCopy
  const copied = await copyText(text)
  flash(copied, copied ? `скопировано: ${text}` : "не удалось скопировать")
})
document.addEventListener("click", (event) => {
  const button = event.target.closest?.(".field-help")
  if (button) {
    pinFieldHint(button)
    return
  }
  // A click anywhere outside the hint dismisses it and drops its highlight.
  if (!event.target.closest?.("#field-hint")) hideFieldHint()
})
// Native title attributes are replaced by the shared hint layer: one look
// everywhere, and it works inside dialogs. Runs once at boot; dynamic markup
// uses data-tip directly.
for (const node of document.querySelectorAll("[title]")) {
  if (!node.dataset.tip) node.dataset.tip = node.getAttribute("title")
  node.removeAttribute("title")
}
document.addEventListener("pointerover", (event) => {
  const button = event.target.closest?.(".field-help")
  if (button) showFieldHint(button)
  else {
    const tipped = event.target.closest?.("[data-tip]")
    if (tipped && !hintPinned) showFieldHint(tipped, tipped.dataset.tipHtml || null)
  }
  if (hintPinned) holdFieldHint(overHintArea(event.target))
})
document.addEventListener("pointerout", (event) => {
  if (!overHintArea(event.target)) return
  if (hintPinned) {
    holdFieldHint(overHintArea(event.relatedTarget))
    return
  }
  hideFieldHint()
})
document.addEventListener("focusin", (event) => {
  const button = event.target.closest?.(".field-help")
  if (button) showFieldHint(button)
})
document.addEventListener("focusout", (event) => {
  // A pinned hint survives losing focus; its own timer, a click, a scroll or a
  // tab switch close it instead.
  if (event.target.closest?.(".field-help") && !hintPinned) hideFieldHint()
})
window.addEventListener("scroll", hideFieldHint, true)
window.addEventListener("resize", hideFieldHint)
// Switching to another app (minimizing) must not leave the hint hanging.
window.addEventListener("blur", hideFieldHint)

let cfg = { providers: {}, models: {}, imageSettings: { defaultProvider: "", defaultModel: "" }, appSettings: { theme: "dark", autoUpdate: false, autoRestart: false, autostart: false } }
let token = localStorage.getItem("pp_token") ?? ""
// The browser's native prompt() cannot be styled or explained, and on a first
// launch with a protected config it appears out of nowhere. One shared modal
// collects the token instead; requests wait for its answer.
let tokenRequest = null
function askToken() {
  if (tokenRequest) return tokenRequest
  tokenRequest = new Promise((resolve) => {
    const dialog = $("dlg-token")
    const input = $("token-input")
    const note = $("token-note")
    input.value = ""
    note.textContent = ""
    const finish = (value) => {
      dialog.close()
      $("token-save").onclick = null
      $("token-cancel").onclick = null
      tokenRequest = null
      resolve(value)
    }
    $("token-save").onclick = () => {
      const value = input.value.trim()
      if (!value) {
        note.textContent = "Введите токен или отмените."
        input.focus()
        return
      }
      finish(value)
    }
    $("token-cancel").onclick = () => finish("")
    dialog.addEventListener("close", () => {
      // Escape or a stray close must not leave the request hanging.
      if (tokenRequest) finish(dialog.returnValue === "save" ? input.value.trim() : "")
    }, { once: true })
    dialog.showModal()
    input.focus()
  })
  return tokenRequest
}
// One styled confirm dialog replaces every native confirm(): the browser box
// cannot be themed and shows the raw origin. Resolves true/false; Escape and a
// click on the backdrop count as "cancel".
let confirmRequest = null
function askConfirm(message, { title = "Подтверждение", okLabel = "Подтвердить", danger = false } = {}) {
  if (confirmRequest) return confirmRequest
  confirmRequest = new Promise((resolve) => {
    const dialog = $("dlg-confirm")
    $("confirm-title").textContent = title
    // An empty title means the dialog asks one plain question and needs no header.
    dialog.querySelector(".dialog-header").hidden = !title
    $("confirm-message").textContent = message
    const ok = $("confirm-ok")
    ok.textContent = okLabel
    ok.className = danger ? "danger" : "primary"
    const finish = (value) => {
      confirmRequest = null
      $("confirm-cancel").onclick = null
      ok.onclick = null
      if (dialog.open) dialog.close()
      resolve(value)
    }
    $("confirm-cancel").onclick = () => finish(false)
    ok.onclick = () => finish(true)
    dialog.addEventListener("close", () => { if (confirmRequest) finish(false) }, { once: true })
    dialog.returnValue = ""
    dialog.showModal()
    ok.focus()
  })
  return confirmRequest
}

// Shared popover for search filters and the "⋮" actions menu. Lives inside the
// open dialog when the anchor is in one, because the top layer paints above
// any page-level element.
const searchMenu = $("search-menu")
let searchMenuAnchor = null
// Optional teardown for a custom menu body (logs keeps a draft of its filters).
let searchMenuOnClose = null
function closeSearchMenu() {
  searchMenu.hidden = true
  searchMenuAnchor?.setAttribute("aria-expanded", "false")
  searchMenuAnchor = null
  const onClose = searchMenuOnClose
  searchMenuOnClose = null
  onClose?.()
}
function positionSearchMenu(anchor) {
  const anchorBox = anchor.getBoundingClientRect()
  const box = searchMenu.getBoundingClientRect()
  const margin = 8
  let left = Math.min(anchorBox.right - box.width, window.innerWidth - box.width - margin)
  if (left < margin) left = margin
  const aboveTop = anchorBox.top - box.height - 6
  let top = aboveTop >= margin ? aboveTop : anchorBox.bottom + 6
  if (top + box.height > window.innerHeight - margin) top = Math.max(margin, aboveTop)
  searchMenu.style.left = `${left}px`
  searchMenu.style.top = `${top}px`
}
function openSearchMenuContent(anchor, render, onClose = null) {
  if (searchMenuAnchor === anchor && !searchMenu.hidden) return closeSearchMenu()
  closeSearchMenu()
  searchMenuAnchor = anchor
  searchMenuOnClose = onClose
  anchor.setAttribute("aria-expanded", "true")
  const host = anchor.closest("dialog") ?? document.body
  if (searchMenu.parentElement !== host) host.append(searchMenu)
  searchMenu.className = "search-menu"
  searchMenu.hidden = false
  render(searchMenu)
  positionSearchMenu(anchor)
}
function openSearchMenu(anchor, items) {
  openSearchMenuContent(anchor, (menu) => menu.replaceChildren(...items.map((item) => {
    if (item.toggle) {
      const label = document.createElement("label")
      label.className = "search-menu-switch"
      const input = document.createElement("input")
      input.type = "checkbox"
      input.checked = Boolean(item.checked)
      input.onchange = () => { if (!item.stayOpen) closeSearchMenu(); item.action?.(input.checked) }
      const text = document.createElement("span")
      text.textContent = item.label
      label.append(input, text)
      return label
    }
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("role", "menuitemradio")
    button.setAttribute("aria-checked", String(Boolean(item.checked)))
    button.className = "search-menu-item" + (item.checked ? " is-active" : "") + (item.danger ? " danger" : "")
    button.textContent = item.label
    button.onclick = () => { closeSearchMenu(); item.action?.() }
    return button
  })))
}
document.addEventListener("click", (event) => {
  if (searchMenu.hidden) return
  // A menu that re-renders itself on click removes the clicked node before the
  // event reaches the document; a detached target belongs to the menu.
  if (!event.target.isConnected) return
  if (event.target.closest?.("#search-menu") || event.target === searchMenuAnchor || searchMenuAnchor?.contains?.(event.target)) return
  closeSearchMenu()
})
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !searchMenu.hidden) closeSearchMenu() })
window.addEventListener("scroll", closeSearchMenu, true)
window.addEventListener("resize", closeSearchMenu)

const emptyStateHtml = (message) => `<div class="sessions-empty"><svg class="sessions-empty-icon" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="88"></circle><path d="M67 67l66 66m0-66-66 66"></path></svg><strong>${esc(message)}</strong></div>`
// Dialog panes have little room: a one-line note instead of the big illustration.
const emptyInlineHtml = (message) => `<div class="empty-inline">${esc(message)}</div>`
const filterIconHtml = (id, label) => `<button id="${id}" class="search-filter" type="button" aria-label="${esc(label)}" data-tip="Фильтр" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.5 8v5.5L10 21v-8Z"></path></svg></button>`

const filters = new Map() // filter text per chips list, keyed by container id
let providersFilter = ""
let pmProviderFilter = ""
let modelSearch = ""
// Checkbox filters: an empty set shows everything, any picked value narrows.
let chainFilters = new Set() // active | disabled | empty
let chainTags = new Set()
let directModelSearch = ""
let directFilters = new Set() // active | disabled
let directTags = new Set()

function syncFilterButton(id, filters) {
  const button = $(id)
  if (button) button.classList.toggle("is-active", filters.size > 0)
}
function toggleFilter(buttonId, filters, value) {
  if (filters.has(value)) filters.delete(value)
  else filters.add(value)
  syncFilterButton(buttonId, filters)
}
/// Tag picks are live (no drag staging here), so the button state is the only
/// extra bookkeeping.
function toggleTagFilter(set, value) {
  if (set.has(value)) set.delete(value)
  else set.add(value)
}

const modelDetails = (provider, id) => cfg.providers[provider]?.modelInfo?.[id] ?? null
const isImageModel = (provider, id) => {
  const info = modelDetails(provider, id)
  const endpoints = Array.isArray(info?.endpoints) ? info.endpoints : []
  const imageEndpoints = endpoints.some((endpoint) => /images\/(generations|tasks|edits)/i.test(String(endpoint)))
  // A manual choice in the model's ⋮ dialog wins over every heuristic.
  if (info?.image === false) return false
  // `image: true` is also written for auto-detected models, so a provider that
  // lists only chat endpoints contradicts it: a chat model ("logfare/auto")
  // was shown as an image one and dropped from chains.
  if (info?.image === true && (!endpoints.length || imageEndpoints)) return true
  return String(info?.type ?? "").toLowerCase() === "image" || imageEndpoints || /image/i.test(String(id))
}
const directModelIds = (provider, definition = cfg.opencodeModels?.[provider]) => {
  const ids = definition?.all === true ? (cfg.providers[provider]?.models ?? []) : (definition?.models ?? [])
  return [...new Set(ids.filter((id) => !isImageModel(provider, id)))]
}
const imageModelEndpoint = (provider, id) => (modelDetails(provider, id)?.endpoints ?? []).find((endpoint) => /images\/generations/i.test(String(endpoint))) ? "images/generations" : "images/tasks"
const imageIcon = (label = "Модель изображений") => `<span class="model-kind-icon" data-tip="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="8.5" cy="9" r="1.5"></circle><path d="m4 17 5-5 3 3 2-2 6 5"></path></svg></span>`
function mergeProviderModelDetails(provider, details) {
  provider.modelInfo ??= {}
  for (const [id, detail] of Object.entries(details ?? {})) {
    const previous = provider.modelInfo[id] ?? {}
    const manualContext = previous.contextLengthManual === true && Number(previous.contextLength) > 0 ? Number(previous.contextLength) : null
    const providerContext = Number(detail?.contextLength) > 0 ? Number(detail.contextLength) : null
    const next = { ...previous, ...(detail && typeof detail === "object" ? detail : {}) }
    if (providerContext) next.providerContextLength = providerContext
    else delete next.providerContextLength
    if (manualContext) {
      next.contextLength = providerContext ? Math.min(manualContext, providerContext) : manualContext
      next.contextLengthManual = true
    } else if (providerContext) {
      next.contextLength = providerContext
      delete next.contextLengthManual
    } else {
      delete next.contextLength
      delete next.contextLengthManual
    }
    provider.modelInfo[id] = next
  }
}
const formatContext = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ""
  if (n >= 1_000_000) {
    const value = Math.round((n / 1_000_000) * 10) / 10
    return `${Number.isInteger(value) ? value : value.toFixed(1)}m`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}
const contextValues = (info) => {
  const provider = Number(info?.providerContextLength)
  const hasProvider = Number.isSafeInteger(provider) && provider > 0
  const raw = Number(info?.contextLength)
  const hasRaw = Number.isSafeInteger(raw) && raw > 0
  const manual = info?.contextLengthManual === true && hasRaw ? Math.min(raw, hasProvider ? provider : raw) : null
  const current = manual ?? (hasRaw ? Math.min(raw, hasProvider ? provider : raw) : hasProvider ? provider : null)
  return { current, manual, provider: hasProvider ? provider : null }
}
const contextLabel = (info) => {
  const values = contextValues(info)
  return values.manual && values.provider
    ? `${formatContext(values.manual)} / ${formatContext(values.provider)}`
    : formatContext(values.current)
}
const contextBadge = (provider, id) => {
  const context = contextLabel(modelDetails(provider, id))
  return context ? `<span class="model-context">ctx ${esc(context)}</span>` : ""
}
const modelContextSuffix = (provider, id) => {
  const context = contextLabel(modelDetails(provider, id))
  return context ? `<span class="model-context">(ctx ${esc(context)})</span>` : ""
}
const chainContextBadge = (upstreams) => {
  const contexts = upstreams
    .map((upstream) => contextValues(modelDetails(upstream.provider, upstream.model)).current)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
  if (!contexts.length) return ""
  return `<span class="pill model-context-pill" data-tip="контекст цепочки">ctx ${esc(formatContext(Math.min(...contexts)))}</span>`
}
const availabilityBadge = (provider, id) => {
  const status = cfg.providers[provider]?.modelAvailability?.[id]
  return status?.available === false
    ? `<span class="model-warning" data-tip="Модель не найдена после обновления списка">⚠ не найдена</span>`
    : ""
}
const imageSettings = () => (cfg.imageSettings ??= { defaultProvider: "", defaultModel: "" })
const appSettings = () => {
  const settings = (cfg.appSettings ??= {})
  settings.theme ??= "dark"
  settings.autoUpdate ??= false
  settings.autoRestart ??= false
  settings.autostart ??= false
  settings.autostartTray ??= false
  settings.tagCategories ??= false
  settings.logsReversed ??= false
  settings.uptimeRefreshMinutes ??= 10
  settings.uptimeChainAverage ??= false
  return settings
}
const tauriInvoke = (command, args) => {
  const invoke = window.__TAURI__?.core?.invoke
  return typeof invoke === "function" ? invoke(command, args) : null
}
const isDesktopApp = () => typeof window.__TAURI__?.core?.invoke === "function"
// Order shown in the theme picker; each key matches a [data-theme-preview] palette.
const THEMES = [
  { id: "dark", label: "Тёмная" },
  { id: "light", label: "Светлая" },
  { id: "system", label: "Как в системе" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "kanagawa", label: "Kanagawa" },
  { id: "nord", label: "Nord" },
  { id: "ayu", label: "Ayu" },
  { id: "breeze", label: "Breeze" },
  { id: "one-dark", label: "One Dark" },
  { id: "dracula", label: "Dracula" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "night-owl", label: "Night Owl" },
]
const THEME_IDS = THEMES.map((theme) => theme.id)
const themeLabel = (id) => THEMES.find((theme) => theme.id === id)?.label ?? "Тёмная"
// Only the light palette needs color-scheme: light; system lets the OS decide.
const LIGHT_THEMES = ["light"]
function applyTheme(theme) {
  if (typeof document === "undefined") return
  const next = THEME_IDS.includes(theme) ? theme : "dark"
  document.body.dataset.theme = next
  const scheme = next === "system" ? "normal" : LIGHT_THEMES.includes(next) ? "light" : "dark"
  document.documentElement.style.colorScheme = scheme
  localStorage.setItem("pp_theme", next)
}
applyTheme(typeof localStorage === "undefined" ? "dark" : localStorage.getItem("pp_theme") ?? "dark")

async function api(path, opts = {}, retried = false) {
  const r = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
  })
  if (r.status === 401 && !retried) {
    token = await askToken()
    localStorage.setItem("pp_token", token)
    if (!token) return r
    return api(path, opts, true)
  }
  return r
}

const apiErrorMessage = (payload, fallback = "неизвестная ошибка") => {
  const text = (value) => {
    if (typeof value === "string" && value) return value
    if (value && typeof value === "object" && typeof value.message === "string" && value.message) return value.message
    return ""
  }
  const error = payload?.error
  return text(error) || text(payload?.detail) || text(fallback) || "неизвестная ошибка"
}
const imageSkillErrorMessage = (message) => /no route: .*\/api\/skills\/image-generation/i.test(String(message))
  ? "endpoint skill недоступен — полностью перезапусти proxy"
  : message

function debugLog(event, details = {}) {
  console.log(`[provider_proxy] ${event}`, { ...details, tab, at: new Date().toISOString() })
}

window.addEventListener("error", (event) => {
  console.error("provider_proxy GUI error", event.error ?? event.message)
  debugLog("js-error", { message: event.message, filename: event.filename, line: event.lineno, column: event.colno })
  // WebKit reports the browser's own layout throttling notice as an uncaught
  // error; it is not a page failure, and alarming the user on every layout pass
  // would be noise.
  if (/ResizeObserver loop/i.test(String(event.message))) return
  // Name the failure in the toast: "ошибка интерфейса" alone told the user
  // nothing and made a cosmetic glitch look like data loss.
  const reason = String(event.message || event.error?.message || "").replace(/\s+/g, " ").trim()
  if (typeof flash === "function") flash(false, reason ? `ошибка интерфейса: ${reason.slice(0, 120)}` : "ошибка интерфейса — обнови страницу и проверь консоль")
})

function flash(ok, msg) {
  const s = $("status")
  s.textContent = msg
  s.className = "status" + (ok ? "" : " err")
  s.style.display = "block"
  clearTimeout(flash.t)
  flash.t = setTimeout(() => (s.style.display = "none"), 2500)
}

/// A new authToken must be saved under the token the server still knows. Swapping
/// the local copy before the PUT made the save itself a 401, and every request
/// after it too: the GUI locked itself out of its own config.
let pendingAuth = null
function setAuthToken(next) {
  pendingAuth = { next, configured: Boolean(cfg.authTokenConfigured) }
  if (next) {
    cfg.authToken = next
    delete cfg.authTokenConfigured
  } else {
    delete cfg.authToken
    delete cfg.authTokenConfigured
  }
  save()
}
function settlePendingAuth(saved) {
  if (!pendingAuth) return
  const { next, configured } = pendingAuth
  pendingAuth = null
  if (saved) {
    token = next
    localStorage.setItem("pp_token", token)
    // The server hands the token back redacted; mirror that so the plain-text
    // field never shows it and the next save keeps it without re-sending it.
    cfg.authToken = ""
    if (next) cfg.authTokenConfigured = true
    else delete cfg.authTokenConfigured
    return renderSettings()
  }
  // The server never took the change, so the form must not claim it did.
  if (configured) {
    cfg.authToken = ""
    cfg.authTokenConfigured = true
  } else {
    delete cfg.authToken
    delete cfg.authTokenConfigured
  }
  renderSettings()
}

let saveT
function modelHasLocalReference(provider, id) {
  if (Object.values(cfg.models ?? {}).some((def) => (def?.upstreams ?? []).some((upstream) => upstream.provider === provider && upstream.model === id))) return true
  return (cfg.opencodeModels?.[provider]?.models ?? []).includes(id)
}
function cleanupModelMetadata() {
  for (const [providerName, provider] of Object.entries(cfg.providers ?? {})) {
    const selected = new Set(provider.models ?? [])
    const available = new Set(Object.entries(provider.modelAvailability ?? {}).filter(([, state]) => state?.available === true).map(([id]) => id))
    for (const id of Object.keys(provider.modelInfo ?? {})) {
      if (!selected.has(id) && !available.has(id) && !modelHasLocalReference(providerName, id)) delete provider.modelInfo[id]
    }
    for (const id of Object.keys(provider.modelAvailability ?? {})) {
      if (!selected.has(id) && !available.has(id) && !modelHasLocalReference(providerName, id)) delete provider.modelAvailability[id]
    }
  }
}
let configDirty = false
let saveSeq = 0
// Saves are serialized: two PUTs in flight while a new authToken is being
// installed would let the older one arrive after the switch and 401 itself.
let saveChain = Promise.resolve()
function save(silent = false) {
  configDirty = true
  // Only the newest save may clear the dirty flag: an older response must not
  // mark a change made while it was in flight as saved.
  const seq = ++saveSeq
  for (const [provider, definition] of Object.entries(cfg.opencodeModels ?? {})) {
    if (definition?.all === true) definition.models = directModelIds(provider, definition)
  }
  cleanupModelMetadata()
  clearTimeout(saveT)
  debugLog("save-scheduled")
  saveT = setTimeout(() => {
    saveChain = saveChain.then(async () => {
      debugLog("save-request")
      const r = await api("/api/config", { method: "PUT", body: JSON.stringify(cfg) })
      if (!r.ok) {
        debugLog("save-failed", { status: r.status })
        settlePendingAuth(false)
        return flash(false, apiErrorMessage(await r.json().catch(() => ({})), `HTTP ${r.status}`))
      }
      settlePendingAuth(true)
      if (seq === saveSeq) configDirty = false
      const j = await r.json().catch(() => ({}))
      debugLog("save-result", { status: r.status, opencodeSynced: j.opencodeSynced, restartRequired: j.restartRequired })
      if (j.opencodeSynced === false) return flash(false, "сохранено, но Opencode не обновлен — проверь путь и вкладку «Логи»")
      if (!silent) flash(true, j.restartRequired ? "сохранено; перезапусти прокси (port)" : "сохранено")
    })
  }, 300)
}

/// Resolves once the queued write has landed on the server. The uptime script
/// asks the proxy for the model list, so a refresh that changed the catalog has
/// to wait for the save instead of racing it.
/// shortcut: waits out save()'s 300ms debounce; upgrade to a real flush promise
/// if that number ever moves.
function saveNow(silent = false) {
  save(silent)
  return new Promise((resolve) => setTimeout(() => saveChain.then(resolve, resolve), 320))
}
