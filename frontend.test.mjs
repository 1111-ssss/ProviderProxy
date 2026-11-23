// Behavioural checks for the GUI. Source is split into frontend/css/*.css and
// frontend/js/*.js, linked from frontend/index.html. These tests load the real
// scripts in a VM and assert what they compute, plus one wiring check that every
// element id the scripts look up exists in the markup.
// Run: node --test frontend.test.mjs
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { test } from "node:test"
import vm from "node:vm"

const FRONTEND = new URL("rust-desktop/frontend/", import.meta.url)
const indexHtml = readFileSync(new URL("index.html", FRONTEND), "utf8")
const cssRefs = [...indexHtml.matchAll(/<link rel="stylesheet" href="\/css\/([^"]+)">/g)].map((m) => m[1])
const jsRefs = [...indexHtml.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1])
const styles = cssRefs.map((n) => readFileSync(new URL(`css/${n}`, FRONTEND), "utf8")).join("\n")
const scripts = jsRefs.map((n) => readFileSync(new URL(`js/${n}`, FRONTEND), "utf8")).join("\n")
const html = indexHtml + "\n" + styles + "\n" + scripts

test("index.html wires every asset the server embeds", () => {
  assert.ok(cssRefs.length >= 1 && jsRefs.length >= 1, "the document must link its assets")
  for (const name of cssRefs) assert.doesNotThrow(() => readFileSync(new URL(`css/${name}`, FRONTEND)), `${name} must exist`)
  for (const name of jsRefs) assert.doesNotThrow(() => readFileSync(new URL(`js/${name}`, FRONTEND)), `${name} must exist`)
  // assets.rs is the Rust server's list; a missing entry means a blank page.
  const assetsRs = readFileSync(new URL("rust-desktop/src/proxy/assets.rs", import.meta.url), "utf8")
  for (const name of cssRefs) assert.ok(assetsRs.includes(`/css/${name}`), `assets.rs must serve /css/${name}`)
  for (const name of jsRefs) assert.ok(assetsRs.includes(`/js/${name}`), `assets.rs must serve /js/${name}`)
})

test("every element id the scripts look up exists in the markup", () => {
  // $("x") is the only lookup helper; a typo or a removed element breaks a tab.
  const used = new Set([...scripts.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))
  assert.ok(used.size > 50, "the scripts should reference many elements")
  const missing = [...used].filter((id) => !indexHtml.includes(`id="${id}"`))
  assert.deepEqual(missing, [], "these ids are used by JS but absent from index.html")
})

test("a '?' inside a settings label never steals the label from its input", () => {
  // Chromium highlights a label's control on hover. Without an explicit `for`,
  // the first labelable element inside <label> is the "?" button, so hovering
  // the field name lit the "?" and a click opened its hint instead of the input.
  const labels = [...indexHtml.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)]
  const withHelp = labels.filter(([, , body]) => body.includes('class="field-help"'))
  assert.ok(withHelp.length >= 8, "settings fields still carry their help buttons")
  const broken = withHelp.filter(([, attrs]) => !/\bfor="/.test(attrs)).map(([, attrs]) => attrs.trim())
  assert.deepEqual(broken, [], "a label that contains a help button needs an explicit for=")
})

test("the concatenated scripts parse", () => {
  new vm.Script(scripts)
})

// A minimal DOM so the pure helpers can run without a browser.
const elements = new Map()
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", querySelectorAll: () => [] })
  return elements.get(id)
}
const context = vm.createContext({ $: element, save: () => {}, esc: (s) => String(s ?? ""), emptyStateHtml: (message) => `<div class="sessions-empty"><strong>${message}</strong></div>` })
const run = (code) => vm.runInContext(code, context)

run(`let cfg = {
  providers: {
    selected: {
      models: ["endpoint-only", "chosen-image", "chat", "chosen-image"],
      modelInfo: {
        "endpoint-only": { endpoints: ["images/generations"] },
        "chosen-image": { type: "image" },
        "cached-image": { type: "image" }
      },
      modelAvailability: { "availability-image": { available: true } }
    },
    unselected: { models: [], modelInfo: { "cached-image": { type: "image" } } }
  },
  imageSettings: { defaultProvider: "unselected", defaultModel: "cached-image", skillModels: { selected: ["cached-image"] } }
}`)
run(scripts.slice(scripts.indexOf("const plural ="), scripts.indexOf("\n\n", scripts.indexOf("const plural ="))))
run(scripts.slice(scripts.indexOf("const modelDetails ="), scripts.indexOf("async function api(")))
run(scripts.slice(scripts.indexOf('let imageProviderFilter = ""'), scripts.indexOf("function imageResultValue(")))
run(scripts.slice(scripts.indexOf("function removeModelFromChains"), scripts.indexOf("function removeImageModelsFromChains")))

test("context labels shrink to a provider maximum and keep the manual value", () => {
  assert.equal(run("formatContext(1000000)"), "1m")
  assert.equal(run("formatContext(1500000)"), "1.5m")
  assert.equal(run("contextLabel({ contextLength: 50000, contextLengthManual: true, providerContextLength: 1000000 })"), "50k / 1m")
  // A manual value above the provider maximum is clamped to it.
  assert.equal(run("contextValues({ contextLength: 2000000, contextLengthManual: true, providerContextLength: 1000000 }).current"), 1000000)
  run('cfg.providers.selected.modelInfo.chat = { contextLength: 500000 }')
  assert.equal(run('modelContextSuffix("selected", "chat")'), '<span class="model-context">(ctx 500k)</span>')
  assert.equal(run('modelContextSuffix("selected", "missing")'), "")
})

test("select-all direct models follow the provider model list", () => {
  run('cfg.providers.selected.models = ["chat", "new-model"]; cfg.opencodeModels = { selected: { all: true, models: ["chat"] } }')
  assert.deepEqual(JSON.parse(run('JSON.stringify(directModelIds("selected"))')), ["chat", "new-model"])
  run('cfg.providers.selected.models = ["endpoint-only", "chosen-image", "chat", "chosen-image"]; delete cfg.opencodeModels')
})

test("only selected Connections image models are available", () => {
  assert.deepEqual(Array.from(run('imageModelIds("selected")')), ["chosen-image", "endpoint-only"])
  assert.deepEqual(Array.from(run('imageModelIds("unselected")')), [])
  assert.deepEqual(Array.from(run('imageModelIds("missing")')), [])
  assert.deepEqual(Array.from(run("imageProviders()")), ["selected"])
  run("renderImageGenerator(); renderImageSettings()")
  assert.equal(element("ig-provider-current").innerHTML, "<strong>selected</strong>")
  assert.equal(element("ig-model").innerHTML, '<option value="chosen-image">chosen-image</option><option value="endpoint-only">endpoint-only</option>')
  assert.equal(element("ig-default-model").innerHTML, element("ig-model").innerHTML)

  // Deselecting the last image model must not resurrect it from cached metadata.
  run('cfg.providers.selected.models = ["chat"]; renderImageGenerator(); renderImageSettings()')
  assert.deepEqual(Array.from(run("imageProviders()")), [])
  assert.equal(element("ig-model").disabled, true)
  assert.equal(element("ig-provider-current").innerHTML, "<strong>—</strong>")
  assert.equal(element("ig-default-model").innerHTML, '<option value="">нет image-моделей</option>')
  assert.match(element("ig-provider-options").innerHTML, /«Подключения»/)
})

test("removing connection models cleans chains and direct models", () => {
  run(`cfg.opencodeModels = { selected: { models: ["chat", "keep"] }, unselected: { models: ["cached-image"] } }`)
  run(`cfg.models = { chain: { upstreams: [{ provider: "selected", model: "chat" }, { provider: "selected", model: "keep" }] } }`)
  run(`cfg.imageSettings = { defaultProvider: "selected", defaultModel: "chat", skillModels: { selected: ["chat"] } }`)

  run('removeModelReferences("selected", "chat")')
  assert.deepEqual(JSON.parse(run("JSON.stringify(cfg.models.chain.upstreams)")), [{ provider: "selected", model: "keep" }])
  assert.deepEqual(JSON.parse(run("JSON.stringify(cfg.opencodeModels.selected.models)")), ["keep"])
  assert.equal(run("cfg.imageSettings.defaultModel"), "")
  assert.equal(run("cfg.imageSettings.skillModels.selected"), undefined)

  run('removeModelReferences("selected", "keep")')
  assert.equal(run("cfg.opencodeModels.selected"), undefined, "empty direct provider should be removed")

  run('removeProviderReferences("unselected")')
  assert.equal(run("cfg.opencodeModels.unselected"), undefined)
})

test("provider model grid drops columns instead of cutting ids", () => {
  const connections = readFileSync(new URL("js/connections.js", FRONTEND), "utf8")
  const source = connections.slice(connections.indexOf("function pmColumnCount"), connections.indexOf("let pmColumnsObserver"))
  const sandbox = vm.createContext({})
  vm.runInContext(source, sandbox)
  const cols = (available, card) => vm.runInContext(`pmColumnCount(${available}, ${card})`, sandbox)
  assert.equal(cols(940, 220), 4, "narrow cards still fit four columns")
  assert.equal(cols(940, 300), 3, "wider cards drop a column rather than truncate")
  assert.equal(cols(460, 300), 1, "a narrow window shows one card per row")
  assert.equal(cols(2000, 120), 4, "four columns is the ceiling")
})

test("chat logs show model separately and put outcomes below it", () => {
  // logCard builds DOM nodes; give it a tiny node/document stub of its own.
  const node = (tag) => ({ tagName: tag, className: "", textContent: "", title: "", dataset: {}, children: [], append(...kids) { this.children.push(...kids) } })
  const ctx = vm.createContext({ document: { createElement: (tag) => node(tag) }, logSessionTitle: () => "" })
  vm.runInContext(scripts.slice(scripts.indexOf("const logCard = ("), scripts.indexOf("const logEmpty =")), ctx)
  const line = "[2026-11-15 10:04:35] logfare-1mil → ответ: logfare-1mil (deepseek-v4.1-flash-1017) [ses:ses_e21fa60f0ffeD7GJwkbN2F0UGs]"
  const card = vm.runInContext(`logCard(${JSON.stringify(line)})`, ctx)
  // The header holds the date and the session chip; the chip keeps the whole id.
  const top = card.children[0]
  assert.equal(top.className, "t")
  const ses = top.children.find((c) => c.className === "ses")
  assert.ok(ses, "the session chip is present")
  assert.equal(ses.textContent, "ses_e21fa60f0ffeD7GJwkbN2F0UGs", "the id is not shortened")
  assert.equal(ses.dataset.sessionCopy, "ses_e21fa60f0ffeD7GJwkbN2F0UGs", "clicking copies the full id")
  const badge = top.children.find((c) => c.className === "b")
  assert.equal(badge.textContent, "ответ", "the kind is the badge, so the message drops it")
  const chain = card.children.find((c) => c.className === "chain")
  assert.equal(chain.textContent, "logfare-1mil (deepseek-v4.1-flash-1017)")
  assert.equal(card.children.find((c) => c.className === "m"), undefined, "answers show only the model/chain")
  const switched = vm.runInContext(
    `logCard("[2026-11-15 10:04:35] logfare-1mil → свитч: logfare-1mil (deepseek-v4.1-flash-1017) — HTTP 429, заблокирован, пробую следующего")`,
    ctx,
  )
  assert.equal(switched.children.find((c) => c.className === "chain").textContent, "logfare-1mil (deepseek-v4.1-flash-1017)")
  assert.equal(switched.children.find((c) => c.className === "m").textContent, "HTTP 429, заблокирован, пробую следующего")
  const failed = vm.runInContext(
    `logCard("[2026-11-15 10:04:35] logfare-1mil → ошибка: logfare-1mil (deepseek-v4.1-flash-1017) — HTTP 401")`,
    ctx,
  )
  assert.equal(failed.children.find((c) => c.className === "m").textContent, "HTTP 401")
  // Image and HTTP lines are not chat events: their name stays above the message.
  const image = vm.runInContext(
    `logCard("[2026-11-15 10:04:35] image images/generations logfare/flux → HTTP 400: provider, model and prompt are required")`,
    ctx,
  )
  assert.equal(image.children.find((c) => c.className === "chain").textContent, "image images/generations logfare/flux")
})

test("the check-in field uses its name as the label and the exact hint copy", () => {
  assert.match(indexHtml, /<span class="field-label">Страница чек-ина \(опционально\)/)
  assert.match(indexHtml, /data-hint="добавляет кнопку для открытия страницы чек-ина \(ежедневного бонуса\)\."/)
})

test("applyTheme accepts every palette offered by the picker", () => {
  // THEMES is the single source: each picker button must map to a real palette.
  const ctx = vm.createContext({ document: { body: { dataset: {} }, documentElement: { style: {} } }, localStorage: { store: {}, getItem(k) { return this.store[k] ?? null }, setItem(k, v) { this.store[k] = v } } })
  vm.runInContext(scripts.slice(scripts.indexOf("const THEMES = ["), scripts.indexOf("async function api(")), ctx)
  const ids = vm.runInContext("THEMES.map((t) => t.id)", ctx)
  for (const id of ids) {
    vm.runInContext(`applyTheme(${JSON.stringify(id)})`, ctx)
    assert.equal(vm.runInContext("document.body.dataset.theme", ctx), id, `${id} must be applied`)
    assert.equal(vm.runInContext("THEME_IDS.includes(document.body.dataset.theme)", ctx), true)
  }
  vm.runInContext('applyTheme("does-not-exist")', ctx)
  assert.equal(vm.runInContext("document.body.dataset.theme", ctx), "dark", "an unknown value falls back to dark")
  // The labels come from the same list, so the settings button can name the theme.
  assert.equal(vm.runInContext('themeLabel("kanagawa")', ctx), "Kanagawa")
})

test("a manual model type overrides the image heuristic", () => {
  // isImageModel must respect the explicit flag from the model dialog.
  const source = scripts.slice(scripts.indexOf("const isImageModel = (provider, id) => {"), scripts.indexOf("const directModelIds ="))
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(
    `const cfg = { providers: { p: { modelInfo: {
        auto:   {},
        forced: { image: true },
        plain:  { image: false, type: "image" }
     } } } }
     const modelDetails = (provider, id) => cfg.providers[provider]?.modelInfo?.[id] ?? null
     ${source}
     this.result = {
       forced: isImageModel("p", "forced"),
       plain: isImageModel("p", "plain"),
       heuristic: isImageModel("p", "some-image-model"),
       auto: isImageModel("p", "auto"),
     }`,
    sandbox,
  )
  // Compare field by field: the sandbox object comes from another realm, so a
  // deepEqual would fail on prototype identity alone.
  assert.equal(sandbox.result.forced, true, "image:true wins")
  assert.equal(sandbox.result.plain, false, "image:false beats type=image")
  assert.equal(sandbox.result.heuristic, true, "the name heuristic still applies")
  assert.equal(sandbox.result.auto, false, "no flag, no image hint")
})

test("digit shortcuts map to the nine tabs", () => {
  // 1..8 pick tabs in order and 0 opens settings; 9 has no tab.
  const line = scripts.match(/const TAB_KEYS = \{([^}]*)\}/)[1]
  const keys = Object.fromEntries([...line.matchAll(/"(\d)":\s*"([a-z-]+)"/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(keys, {
    "1": "providers", "2": "connections", "3": "integrations", "4": "chains",
    "5": "models", "6": "images", "7": "logs", "8": "usage", "0": "settings",
  })
  const tabs = JSON.parse(scripts.match(/const TABS = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  for (const name of Object.values(keys)) assert.ok(tabs.includes(name), `${name} must be a tab`)
  assert.equal("9" in keys, false, "9 has no tab")
})

test("a quick second digit reaches tabs 11..19", () => {
  const source = scripts.slice(
    scripts.indexOf("const TAB_KEYS"),
    scripts.lastIndexOf('document.addEventListener("keydown"'),
  )
  const sandbox = { TABS: ["providers", "connections", "integrations", "chains", "models", "images", "logs", "usage", "settings", "ten", "eleven"] }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.equal(sandbox.digitTab("1", 0), "providers", "first press goes to tab 1")
  assert.equal(sandbox.digitTab("1", 100), "eleven", "second press within 200ms goes to tab 11")
  assert.equal(sandbox.digitTab("1", 400), "providers", "a slow press starts over")
  assert.equal(sandbox.digitTab("2", 450), "connections")
  // Only nine tabs exist in the app, so tab 11 falls back to the first one.
  assert.equal(sandbox.digitTab("5", 500), "models")
  assert.equal(sandbox.digitTab("5", 550), "providers", "missing tab 15 falls back to the first")
})

test("update progress survives late events and missing content length", () => {
  // Two real bugs: an event arriving after the download finished flipped
  // "Перезапустить" back to "Обновление", and a server without Content-Length
  // showed an empty bar with no feedback at all.
  const source = scripts.slice(
    scripts.indexOf("let updateInfo = null"),
    scripts.indexOf("updateNavButton.onclick"),
  )
  const sandbox = { $: element, window: {} }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const button = element("update-nav-button")
  button.dataset = {}
  const label = element("update-nav-label")
  const bar = element("update-progress")
  bar.classList = { toggle() {}, remove() {} }
  bar.style = {}
  element("update-progress-fill").style = {}

  vm.runInContext('setUpdateNav({ mode: "progress", done: 50, total: 100 })', sandbox)
  assert.equal(label.textContent, "Обновление 50%")
  assert.equal(bar.hidden, false, "the bar is shown while downloading")

  // No Content-Length: report the size instead of an empty bar.
  vm.runInContext('setUpdateNav({ mode: "progress", done: 2097152, total: 0 })', sandbox)
  assert.equal(label.textContent, "Обновление 2.0 МБ")
  assert.equal(bar.hidden, false, "an unknown total must still show a bar")

  // Finished: the entry offers a restart.
  vm.runInContext('setUpdateNav({ mode: "restart" })', sandbox)
  assert.equal(label.textContent, "Перезапустить")
  assert.equal(bar.hidden, true)
})

test("log pages keep newest records on page one and prepend fresh lines at top", () => {
  // Page zero is the newest. Entries are shown newest-first within the page,
  // so fresh lines arrive at the top without rearranging older ones.
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("function logPageSlice"), logs.indexOf("\n\nfunction logMatches"))
  const sandbox = { lines: Array.from({ length: 5 }, (_, i) => `line-${i + 1}`) }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(logPageSlice(lines, 0, 3))', sandbox)), ["line-1", "line-2", "line-3"])
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(logPageSlice(lines, 1, 3))', sandbox)), ["line-4", "line-5"])
})

test("clearing the log search resets the query, page and visible input", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf('$("log-search-clear").onclick ='), logs.indexOf('$("log-filter-menu").onclick ='))
  const input = { value: "timeout", focus() { this.focused = true } }
  const button = { classList: { toggle() {} } }
  let renders = 0
  const sandbox = {
    logQuery: "timeout",
    logPage: 3,
    logFilters: new Set(["error"]),
    syncFilterButton: () => {},
    renderLogs() { renders++ },
    $: (id) => id === "log-search" ? input : button,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  button.onclick()
  assert.equal(sandbox.logQuery, "")
  assert.equal(sandbox.logFilters.size, 0, "the clear button drops the event filter too")
  assert.equal(sandbox.logPage, 0)
  assert.equal(input.value, "")
  assert.equal(input.focused, true)
  assert.equal(renders, 1)
})

test("the all-days session search does not reuse the main session query", () => {
  const usage = readFileSync(new URL("js/usage.js", FRONTEND), "utf8")
  const source = usage.slice(usage.indexOf("function usageSessionRows"), usage.indexOf("function usageSessionTable"))
  const sandbox = {
    sessionQuery: "beta",
    sessionTitle: (_titles, id) => id === "a" ? "alpha" : "beta",
    sortSessionRows: (rows) => rows,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const rows = JSON.parse(vm.runInContext(
    'JSON.stringify(usageSessionRows({ a: { ok: 1 }, b: { ok: 1 } }, {}, "alpha"))',
    sandbox,
  ))
  assert.deepEqual(rows.map((row) => row.id), ["a"], "the dialog uses its own query")
})

test("an empty session list shows the centered not-found illustration", () => {
  const usage = readFileSync(new URL("js/usage.js", FRONTEND), "utf8")
  const source = usage.slice(usage.indexOf("const sortArrow"), usage.indexOf('document.addEventListener("click"'))
  const sandbox = {
    sessionQuery: "",
    sessionSort: { key: "lastSeen", dir: -1 },
    sessionTitle: (_titles, id) => id,
    esc: (value) => String(value ?? ""),
    fmtNum: (value) => String(value ?? 0),
    fmtTok: (value) => String(value ?? 0),
    fmtUptime: (value) => String(value ?? 0),
    emptyStateHtml: (message) => `<div class="sessions-empty"><svg class="sessions-empty-icon"></svg><strong>${message}</strong></div>`,
    $: () => ({ textContent: "", innerHTML: "", querySelectorAll: () => [] }),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const empty = vm.runInContext("sessionTableHtml([])", sandbox)
  assert.match(empty, /class="sessions-empty-icon"/)
  assert.match(empty, /<strong>ничего не найдено<\/strong>/)
  assert.doesNotMatch(empty, /<table>/)
  const filled = vm.runInContext('sessionTableHtml([{ id: "session-1", stat: { requests: 1 }, title: "Session" }])', sandbox)
  assert.match(filled, /^<table>/)
})

test("confirmed setting resets remove overrides and restore defaults", async () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.lastIndexOf('document.querySelectorAll("[data-reset]")'), providers.indexOf('$("opencode-toggle").onclick'))
  const runReset = async (id, initial) => {
    const button = { dataset: { reset: id } }
    const controls = {
      "s-retry-forever": { checked: true },
      "s-pending-buffer": { value: "16384" },
    }
    let saves = 0
    let renders = 0
    const sandbox = {
      cfg: { ...initial },
      document: { querySelectorAll: () => [button] },
      askConfirm: async () => true,
      renderSettings() { renders++ },
      renderOpenCode() {},
      save() { saves++ },
      $: (elementId) => controls[elementId] ?? {},
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    await button.onclick()
    return { cfg: sandbox.cfg, controls, saves, renders }
  }

  const limit = await runReset("s-limit", { limitCooldownSec: 12 })
  assert.equal(limit.cfg.limitCooldownSec, undefined)
  assert.equal(limit.saves, 1)
  assert.equal(limit.renders, 1)

  const retry = await runReset("s-retry-forever", { retryForever: true })
  assert.equal(retry.cfg.retryForever, undefined)
  assert.equal(retry.controls["s-retry-forever"].checked, false)

  const buffer = await runReset("s-pending-buffer", { pendingBufferBytes: 16384 })
  assert.equal(buffer.cfg.pendingBufferBytes, undefined)
  assert.equal(buffer.controls["s-pending-buffer"].value, "8388608")

  const path = await runReset("oc-path", { opencodeConfig: "/tmp/opencode.json" })
  assert.equal(path.cfg.opencodeConfig, undefined)
})

test("reset buttons appear only for non-default values, using the backend default", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("const SETTINGS_RESET_DEFAULTS"), providers.indexOf("// Live typing"))
  const controls = {
    "s-port": { value: "8787" },
    "s-limit": { value: "300" },
    "s-retry-forever": { checked: false },
    "s-pending-buffer": { value: "8388608" },
    "oc-path": { value: "~/.config/opencode/opencode.json" },
    "oc-provider": { value: "provider-proxy" },
  }
  const buttons = Object.fromEntries(Object.keys(controls).map((id) => [id, { dataset: { reset: id }, hidden: false }]))
  const sandbox = {
    opencodeConfigDefault: "~/.config/opencode/opencode.json",
    DEFAULT_OPENCODE_PROVIDER: "provider-proxy",
    document: { querySelectorAll: () => Object.values(buttons) },
    $: (id) => controls[id],
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("syncResetVisibility()", sandbox)
  for (const [id, button] of Object.entries(buttons)) assert.equal(button.hidden, true, `${id}: default value hides reset`)
  // The backend default is .json here: the .jsonc constant must not win.
  controls["oc-path"].value = "~/.config/opencode/opencode.jsonc"
  controls["s-port"].value = "9000"
  controls["s-retry-forever"].checked = true
  vm.runInContext("syncResetVisibility()", sandbox)
  assert.equal(buttons["oc-path"].hidden, false, "any path other than the effective default shows reset")
  assert.equal(buttons["s-port"].hidden, false)
  assert.equal(buttons["s-retry-forever"].hidden, false)
  assert.equal(buttons["s-limit"].hidden, true)
})

test("provider table keeps four columns, the model count and a dialog-only delete", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("function renderProviders()"), providers.indexOf('$("p-checkins").onclick'))
  const table = {
    rows: [],
    set innerHTML(html) { this.rows = html ? [{ cells: [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1]) }] : [] },
    insertRow() { const row = { cells: [], querySelector: () => ({}), set innerHTML(html) { this.html = html; this.cells = [...html.matchAll(/<td\b([^>]*)>/g)].map((m) => m[1]) } }; this.rows.push(row); return row },
  }
  const emptyBox = { innerHTML: "" }
  const sandbox = {
    cfg: { providers: { alpha: { baseURL: "https://a.example/v1", models: ["m1", "m2"] } } },
    providersFilter: "",
    esc: (s) => String(s ?? ""),
    emptyStateHtml: (message) => `<div class="sessions-empty"><strong>${message}</strong></div>`,
    $: (id) => id === "providers" ? table : id === "providers-empty" ? emptyBox : { style: {} },
    openProviderDialog() {}, openUrl() {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("renderProviders()", sandbox)
  assert.deepEqual(table.rows[0].cells, ["имя", "baseURL", "модели", ""], "header has four columns")
  assert.equal(table.rows[1].cells.length, 4, "data row has four cells")
  assert.match(table.rows[1].html, /<td class="muted">2<\/td>/, "model count is rendered")
  assert.doesNotMatch(table.rows[1].html, /data-a="del"/, "delete lives in the edit dialog, not the row")
  sandbox.providersFilter = "нет такого"
  vm.runInContext("renderProviders()", sandbox)
  assert.equal(table.rows.length, 0, "search hides non-matching providers")
  assert.match(emptyBox.innerHTML, /ничего не найдено/)
})

test("adding direct models hides delete even when that provider already has models", () => {
  const models = readFileSync(new URL("js/models.js", FRONTEND), "utf8")
  const source = models.slice(models.indexOf("function openOpenCodeModelDialog"), models.indexOf("function renderOpenCodeModelDialog"))
  const deleteButton = { hidden: false }
  const dialog = { returnValue: "save", showModal() {} }
  const sandbox = {
    cfg: { providers: { p: { models: ["m"] } }, opencodeModels: { p: { models: ["m"] } } },
    directModelIds: () => ["m"],
    directDraft: null,
    dlgOpenCodeModel: dialog,
    renderOpenCodeModelDialog() {},
    $: (id) => id === "dom-delete" ? deleteButton : {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("openOpenCodeModelDialog()", sandbox)
  assert.equal(deleteButton.hidden, true, "add mode never exposes a destructive action")
  vm.runInContext('openOpenCodeModelDialog("p")', sandbox)
  assert.equal(deleteButton.hidden, false, "edit mode exposes delete for an existing entry")
})

test("model context reset confirms and clears the manual value", async () => {
  const source = scripts.slice(scripts.indexOf('$("dms-context-reset").onclick ='), scripts.indexOf("dlgModelSettings.addEventListener"))
  const field = { value: "128000", focus() { this.focused = true } }
  const button = { hidden: false }
  const sandbox = { $: (id) => id === "dms-context" ? field : button, askConfirm: async () => true }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  await button.onclick()
  assert.equal(field.value, "", "the reset leaves /v1/models in control")
  assert.equal(field.focused, true)
  assert.equal(button.hidden, true, "reset hides itself once the value is default")
})

test("askConfirm resolves ok/cancel and Escape counts as cancel", async () => {
  const core = readFileSync(new URL("js/core.js", FRONTEND), "utf8")
  const source = core.slice(core.indexOf("let confirmRequest = null"), core.indexOf("// Shared popover"))
  const nodes = {}
  const node = (id) => nodes[id] ??= { textContent: "", className: "", onclick: null, focus() { this.focused = true } }
  const dialog = {
    open: false, returnValue: "", listeners: {},
    showModal() { this.open = true },
    close() { this.open = false; this.listeners.close?.() },
    addEventListener(type, fn) { this.listeners[type] = fn },
    querySelector: () => header,
  }
  const header = { hidden: false }
  const sandbox = { $: (id) => id === "dlg-confirm" ? dialog : node(id) }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const okRun = vm.runInContext('askConfirm("Удалить?", { okLabel: "Удалить", danger: true })', sandbox)
  assert.equal(dialog.open, true)
  assert.equal(header.hidden, false, "a titled dialog keeps its header")
  assert.equal(node("confirm-message").textContent, "Удалить?")
  assert.equal(node("confirm-ok").textContent, "Удалить")
  assert.equal(node("confirm-ok").className, "danger")
  node("confirm-ok").onclick()
  assert.equal(await okRun, true)
  assert.equal(dialog.open, false)

  const cancelRun = vm.runInContext('askConfirm("Сбросить?")', sandbox)
  node("confirm-cancel").onclick()
  assert.equal(await cancelRun, false)

  const escapeRun = vm.runInContext('askConfirm("Выйти?")', sandbox)
  dialog.close() // Escape closes the dialog without pressing a button
  assert.equal(await escapeRun, false)

  const resetRun = vm.runInContext('askConfirm("Вернуть значение по умолчанию?", { title: "", okLabel: "Подтвердить сброс" })', sandbox)
  assert.equal(header.hidden, true, "an empty title hides the header")
  assert.equal(node("confirm-ok").textContent, "Подтвердить сброс")
  node("confirm-cancel").onclick()
  assert.equal(await resetRun, false)
})

test("connections bulk select ticks everything and deselect cleans references", () => {
  const connections = readFileSync(new URL("js/connections.js", FRONTEND), "utf8")
  const source = connections.slice(connections.indexOf("function pmBulkSelect"), connections.indexOf('$("pm-menu").onclick'))
  const removed = []
  const sandbox = {
    cfg: { providers: { p: { models: ["a"], modelAvailability: { a: { available: true }, b: { available: true }, c: { available: false } } } } },
    pmState: { provider: "p", ids: ["a", "b", "c"] },
    chainFillSnapshot: () => new Map(),
    removeModelReferences(provider, id) { removed.push(id) },
    isAutoAllProvider: () => false,
    saved: false,
    save() {},
    renderProviderModels() {}, renderProviders() {}, renderModels() {}, renderOpencodeModels() {}, renderOpenCode() {}, renderImageGenerator() {},
    reportEmptiedChains() {}, flash() {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("pmBulkSelect(true)", sandbox)
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.providers.p.models)", sandbox)), ["a", "b", "c"])
  vm.runInContext("pmBulkSelect(false)", sandbox)
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.providers.p.models)", sandbox)), [])
  assert.deepEqual(removed, ["a", "b", "c"], "deselect removes every reference, not just the first")
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(pmState.ids)", sandbox)), ["a", "b"], "unavailable ids drop out of the shown list")
})

test("the model selection filter keeps only the requested ticks", () => {
  const connections = readFileSync(new URL("js/connections.js", FRONTEND), "utf8")
  const source = connections.slice(connections.indexOf("function renderPmList"), connections.indexOf("No redraw per click") - 5) + "\n}"
  const list = { innerHTML: "", querySelectorAll: () => [] }
  const menuButton = { classList: { toggle() {} }, dataset: {} }
  const sandbox = {
    cfg: { providers: { p: { models: ["a"] } } },
    pmState: { provider: "p", ids: ["a", "b"], filter: "" },
    pmFilters: new Set(["selected"]),
    isAutoAllProvider: () => false,
    isImageModel: () => false,
    contextBadge: () => "", availabilityBadge: () => "",
    modelCardsHtml: (_provider, ids) => ids.map((id) => `<label data-id="${id}"></label>`).join(""),
    syncPmFilterButton: () => {},
    esc: (s) => String(s ?? ""),
    emptyStateHtml: (message) => `<div class="sessions-empty"><strong>${message}</strong></div>`,
    $: (id) => (id === "pm-filter-menu" ? menuButton : list),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("renderPmList()", sandbox)
  assert.match(list.innerHTML, /data-id="a"/)
  assert.doesNotMatch(list.innerHTML, /data-id="b"/, "unselected model is filtered out")
  sandbox.pmFilters.clear()
  sandbox.pmFilters.add("unselected")
  vm.runInContext("renderPmList()", sandbox)
  assert.match(list.innerHTML, /data-id="b"/)
  assert.doesNotMatch(list.innerHTML, /data-id="a"/)
  sandbox.pmState.filter = "нет такого"
  sandbox.pmFilters.clear()
  vm.runInContext("renderPmList()", sandbox)
  assert.match(list.innerHTML, /sessions-empty/, "a fruitless search shows the shared illustration")
})

test("model filters are independent checkboxes", () => {
  const connections = readFileSync(new URL("js/connections.js", FRONTEND), "utf8")
  const source = connections.slice(connections.indexOf("function togglePmFilter"), connections.indexOf('$("pm-filter-menu").onclick'))
  const sandbox = {
    pmFilters: new Set(),
    renderPmList: () => {},
    syncPmFilterButton: () => {},
    $: () => ({ classList: { toggle() {} }, dataset: {} }),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const state = () => JSON.parse(vm.runInContext("JSON.stringify([...pmFilters])", sandbox))
  vm.runInContext('togglePmFilter("selected")', sandbox)
  assert.deepEqual(state(), ["selected"])
  vm.runInContext('togglePmFilter("image")', sandbox)
  assert.deepEqual(state(), ["selected", "image"], "groups combine")
  vm.runInContext('togglePmFilter("unselected")', sandbox)
  assert.deepEqual(state(), ["selected", "image", "unselected"], "every box can be on at once")
  vm.runInContext('togglePmFilter("unselected")', sandbox)
  assert.deepEqual(state(), ["selected", "image"], "a second click clears the box")
})

test("log search also matches the session title", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("const LOG_PAGE_SIZE"), logs.indexOf("function renderLogs"))
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('logSessionTitles = { ses_abc123: "Починить меню" }', sandbox)
  const line = "[2026-11-23 10:00:00] chain → ответ: p/m [ses:ses_abc123]"
  const match = (query) => vm.runInContext(`logQuery = ${JSON.stringify(query)}; logMatches(${JSON.stringify(line)})`, sandbox)
  assert.equal(match(""), true)
  assert.equal(match("меню"), true, "the session title is searchable")
  assert.equal(match("abc123"), true, "the id still matches")
  assert.equal(match("нет такого"), false)
  // Event kinds are independent boxes; "Инфо" is everything without an outcome.
  const kind = (filters, value) => vm.runInContext(
    `logQuery = ""; logFilters = new Set(${JSON.stringify(filters)}); logMatches(${JSON.stringify(value)})`, sandbox)
  assert.equal(kind(["info"], "config обновлён"), true, "neutral lines are info")
  assert.equal(kind(["info"], line), false, "an answer is not info")
  assert.equal(kind(["answer"], line), true)
  assert.equal(kind(["info", "answer"], line), true, "boxes combine")
  assert.equal(kind([], "config обновлён"), true, "no filter shows everything")
})
