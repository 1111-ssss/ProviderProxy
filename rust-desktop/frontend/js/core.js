const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
// Russian counts need three forms: 1 модель, 2 модели, 5 моделей.
const plural = (n, one, few, many) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 > 1 && n % 10 < 5 && (n % 100 < 10 || n % 100 > 20) ? few : many}`
const openUrl = (u) => window.open(/^https?:\/\//.test(u) ? u : "https://" + u, "_blank")

// The settings cards scroll, so the "?" hint is a fixed layer placed next to
// the button and clamped to the viewport. It opens only for the button itself:
// hovering the label used to cover the input and block typing.
const fieldHint = $("field-hint")
function showFieldHint(button) {
  const hint = button?.dataset.hint
  if (!hint) return
  fieldHint.textContent = hint
  fieldHint.hidden = false
  const anchor = button.getBoundingClientRect()
  const box = fieldHint.getBoundingClientRect()
  const margin = 8
  // Beside the button, not under it: the field it explains sits right below,
  // and a hint on top of the input still hides what the user is typing.
  let left = anchor.right + 8
  if (left + box.width > window.innerWidth - margin) left = anchor.left - box.width - 8
  if (left < margin) {
    left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin))
  }
  const top = Math.max(margin, Math.min(anchor.top + anchor.height / 2 - box.height / 2, window.innerHeight - box.height - margin))
  fieldHint.style.top = `${top}px`
  fieldHint.style.left = `${left}px`
}
const hideFieldHint = () => { fieldHint.hidden = true }
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
document.addEventListener("pointerover", (event) => {
  const button = event.target.closest?.(".field-help")
  if (button) showFieldHint(button)
})
document.addEventListener("pointerout", (event) => {
  if (event.target.closest?.(".field-help")) hideFieldHint()
})
document.addEventListener("focusin", (event) => {
  const button = event.target.closest?.(".field-help")
  if (button) showFieldHint(button)
})
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.(".field-help")) hideFieldHint()
})
window.addEventListener("scroll", hideFieldHint, true)
window.addEventListener("resize", hideFieldHint)

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
const filters = new Map() // filter text per chips list, keyed by container id
let providersFilter = ""
let pmProviderFilter = ""

const modelDetails = (provider, id) => cfg.providers[provider]?.modelInfo?.[id] ?? null
const isImageModel = (provider, id) => {
  const info = modelDetails(provider, id)
  // A manual choice in the model's ⋮ dialog wins over the heuristics below.
  if (info?.image === true) return true
  if (info?.image === false) return false
  const endpoints = Array.isArray(info?.endpoints) ? info.endpoints : []
  return String(info?.type ?? "").toLowerCase() === "image" || endpoints.some((endpoint) => /images\/(generations|tasks)/i.test(String(endpoint))) || /image/i.test(String(id))
}
const directModelIds = (provider, definition = cfg.opencodeModels?.[provider]) => {
  const ids = definition?.all === true ? (cfg.providers[provider]?.models ?? []) : (definition?.models ?? [])
  return [...new Set(ids.filter((id) => !isImageModel(provider, id)))]
}
const imageModelEndpoint = (provider, id) => (modelDetails(provider, id)?.endpoints ?? []).find((endpoint) => /images\/generations/i.test(String(endpoint))) ? "images/generations" : "images/tasks"
const imageIcon = (label = "Модель изображений") => `<span class="model-kind-icon" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="8.5" cy="9" r="1.5"></circle><path d="m4 17 5-5 3 3 2-2 6 5"></path></svg></span>`
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
  return `<span class="pill model-context-pill" title="контекст цепочки">ctx ${esc(formatContext(Math.min(...contexts)))}</span>`
}
const availabilityBadge = (provider, id) => {
  const status = cfg.providers[provider]?.modelAvailability?.[id]
  return status?.available === false
    ? `<span class="model-warning" title="Модель не найдена в последнем успешном ответе /v1/models">⚠ не найдена</span>`
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
  if (typeof flash === "function") flash(false, "ошибка интерфейса — обнови страницу и проверь консоль")
})

function flash(ok, msg) {
  const s = $("status")
  s.textContent = msg
  s.className = "status" + (ok ? "" : " err")
  s.style.display = "block"
  clearTimeout(flash.t)
  flash.t = setTimeout(() => (s.style.display = "none"), 2500)
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
  saveT = setTimeout(async () => {
    debugLog("save-request")
    const r = await api("/api/config", { method: "PUT", body: JSON.stringify(cfg) })
    if (!r.ok) {
      debugLog("save-failed", { status: r.status })
      return flash(false, apiErrorMessage(await r.json().catch(() => ({})), `HTTP ${r.status}`))
    }
    if (seq === saveSeq) configDirty = false
    const j = await r.json().catch(() => ({}))
    debugLog("save-result", { status: r.status, opencodeSynced: j.opencodeSynced, restartRequired: j.restartRequired })
    if (j.opencodeSynced === false) return flash(false, "сохранено, но интеграция не обновлена — проверь путь и вкладку «Логи»")
    if (!silent) flash(true, j.restartRequired ? "сохранено; перезапусти прокси (port)" : "сохранено")
  }, 300)
}

// The Windows window is undecorated (see main.rs): these buttons are the only
// way to minimize, maximize and close it, so they are wired before any tab
// renders. The bar itself is hidden unless the page was flagged as a custom frame.
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.()
if (appWindow) {
  $("titlebar-minimize").onclick = () => appWindow.minimize()
  $("titlebar-maximize").onclick = () => appWindow.toggleMaximize()
  $("titlebar-close").onclick = () => appWindow.close()
  // Swap the maximize glyph for "restore" and keep the label honest.
  const syncFrameState = async () => {
    const maximized = await appWindow.isMaximized()
    document.body.classList.toggle("is-maximized", maximized)
    const label = maximized ? "Восстановить окно" : "Развернуть окно"
    $("titlebar-maximize").setAttribute("aria-label", label)
    $("titlebar-maximize").title = label
  }
  appWindow.onResized(syncFrameState)
  syncFrameState()
}

