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

test("the update entry sits pinned above Settings, outside the scrolling tab list", () => {
  // A tab list that scrolls must not carry the update entry: it used to sit
  // inside .tabs-scroll and showed up right under the last tab group, floating
  // in the middle of the navigation.
  const nav = indexHtml.slice(indexHtml.indexOf("<nav"), indexHtml.indexOf("</nav>"))
  const scroll = nav.slice(nav.indexOf('class="tabs-scroll"'), nav.indexOf('class="tabs-splitter"'))
  assert.ok(scroll.length > 100, "the scrolling tab list must exist")
  assert.ok(!scroll.includes("update-nav-button"), "the update entry must not live in the scrolling list")
  const afterSplitter = nav.slice(nav.indexOf('class="tabs-splitter"'))
  const update = afterSplitter.indexOf('id="update-nav-button"')
  const settings = afterSplitter.indexOf('class="settings-nav-button"')
  assert.ok(update > -1, "the update entry must follow the splitter")
  assert.ok(update < settings, "the update entry goes above Settings")
})

test("the desktop app flags its own frame so the window buttons are drawn", () => {
  // The window is undecorated: without this flag the caption bar has no
  // minimize/maximize/close at all, which is what Windows showed. On Windows a
  // Tauri init script runs before <html> exists, so the flag must come from the
  // page script, and only where window control actually exists.
  const source = scripts.slice(
    scripts.indexOf("// The desktop window is undecorated"),
    scripts.indexOf("// The settings cards scroll"),
  )
  const frame = (appWindow) => {
    const controls = { onclick: null, setAttribute() {}, dataset: {} }
    const sandbox = {
      window: { __TAURI__: appWindow ? { window: { getCurrentWindow: () => appWindow } } : undefined },
      document: { documentElement: { dataset: {} }, body: { classList: { toggle() {} } } },
      $: () => controls,
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    return sandbox.document.documentElement.dataset.frame ?? ""
  }
  const appWindow = { minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onResized() {} }
  assert.equal(frame(appWindow), "custom", "inside the desktop webview the buttons get laid out")
  assert.equal(frame(null), "", "a plain browser keeps the browser's own frame")
  // A Tauri init script cannot do it: on Windows it runs before <html> exists.
  const mainRs = readFileSync(new URL("rust-desktop/src/main.rs", import.meta.url), "utf8")
  assert.ok(!mainRs.includes("dataset.frame"), "the flag must not come back as an init script")
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
  assert.equal(element("ig-provider-current").innerHTML, "<strong>-</strong>")
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

test("lifetime panel shows request-based favourites and generated images, not speed", () => {
  const usage = readFileSync(new URL("js/usage.js", FRONTEND), "utf8")
  const source = usage.slice(usage.indexOf("function renderLifetimePanel"), usage.indexOf("const usageDayLabel"))
  const tiles = { innerHTML: "" }
  const sandbox = {
    fmtNum: String,
    fmtTok: String,
    esc: (value) => String(value ?? ""),
    statTile: (kind, value, label) => `[${kind}|${value}|${label}]`,
    TILE_ICONS: { providers: "", models: "" },
    $: () => tiles,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('renderLifetimePanel({lifetimeTokens:{requests:15,tokensIn:100,tokensOut:200,streamMs:9000,imagesGenerated:7,providers:{alpha:8,beta:7},models:{"alpha/m1":9,"beta/m2":6}}})', sandbox)
  // One card holds both favourites: a separate wide tile for the model used to
  // leave a hole exactly one small tile wide in front of the last tile.
  assert.match(tiles.innerHTML, /tile-favourites/, "both favourites live in one block")
  assert.match(tiles.innerHTML, /Любимые за всё время/)
  assert.match(tiles.innerHTML, /alpha\/m1/)
  assert.match(tiles.innerHTML, /"alpha"/)
  assert.match(tiles.innerHTML, /9 запросов/)
  // 9 against an average of 6 for the rest is +50%.
  assert.match(tiles.innerHTML, /\+50% к среднему/)
  // 8 against 7 is +14%.
  assert.match(tiles.innerHTML, /\+14% к среднему/)
  assert.match(tiles.innerHTML, /изображений сгенерировано/)
  assert.match(tiles.innerHTML, /\|7\|/)
  assert.doesNotMatch(tiles.innerHTML, /в секунду/)
  // One entry is the whole field: no "average of the rest" to compare against.
  vm.runInContext('renderLifetimePanel({lifetimeTokens:{providers:{only:5},models:{}}})', sandbox)
  assert.doesNotMatch(tiles.innerHTML, /к среднему/)
  assert.match(tiles.innerHTML, />-</, "an empty favourite is a dash, not a blank tile")
})

test("provider model grid drops columns instead of cutting ids", () => {
  const shared = readFileSync(new URL("js/shared.js", FRONTEND), "utf8")
  const source = shared.slice(shared.indexOf("function pmColumnCount"), shared.indexOf("let pmColumnsObservers"))
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
        plain:  { image: false, type: "image" },
        chatAuto: { image: true, endpoints: ["chat/completions", "messages", "responses"] },
        imageAuto: { image: true, endpoints: ["images/generations"] }
     } } } }
     const modelDetails = (provider, id) => cfg.providers[provider]?.modelInfo?.[id] ?? null
     ${source}
     this.result = {
       forced: isImageModel("p", "forced"),
       plain: isImageModel("p", "plain"),
       heuristic: isImageModel("p", "some-image-model"),
       auto: isImageModel("p", "auto"),
       chatAuto: isImageModel("p", "chatAuto"),
       imageAuto: isImageModel("p", "imageAuto"),
     }`,
    sandbox,
  )
  // Compare field by field: the sandbox object comes from another realm, so a
  // deepEqual would fail on prototype identity alone.
  assert.equal(sandbox.result.forced, true, "image:true wins")
  assert.equal(sandbox.result.plain, false, "image:false beats type=image")
  assert.equal(sandbox.result.heuristic, true, "the name heuristic still applies")
  assert.equal(sandbox.result.auto, false, "no flag, no image hint")
  assert.equal(sandbox.result.chatAuto, false, "chat endpoints override a stale auto-detected image flag")
  assert.equal(sandbox.result.imageAuto, true, "image endpoints still mean an image model")
})

test("digit shortcuts map to the ten tabs", () => {
  // 1..9 pick tabs in order and 0 opens settings.
  const line = scripts.match(/const TAB_KEYS = \{([^}]*)\}/)[1]
  const keys = Object.fromEntries([...line.matchAll(/"(\d)":\s*"([a-z-]+)"/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(keys, {
    "1": "providers", "2": "connections", "3": "integrations", "4": "chains",
    "5": "models", "6": "images", "7": "logs", "8": "usage", "9": "uptime", "0": "settings",
  })
  const tabs = JSON.parse(scripts.match(/const TABS = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  for (const name of Object.values(keys)) assert.ok(tabs.includes(name), `${name} must be a tab`)
  assert.equal(keys["9"], "uptime", "9 opens the uptime tab")
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
  // Only nine tabs exist in the app, so a double press of "5" cannot reach tab
  // 15: it falls back to tab 5, not to the first tab.
  assert.equal(sandbox.digitTab("5", 500), "models")
  assert.equal(sandbox.digitTab("5", 550), "models", "missing tab 15 falls back to tab 5")
  assert.equal(sandbox.digitTab("2", 600), "connections")
  assert.equal(sandbox.digitTab("2", 650), "connections", "double 2 stays on the second tab")
  assert.equal(sandbox.digitTab("3", 900), "integrations")
  assert.equal(sandbox.digitTab("3", 950), "integrations", "double 3 stays on the third tab")
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
    logChatFilters: new Set(["ses_1"]),
    logModelFilters: new Set(["alpha"]),
    syncLogFilterButton: () => {},
    renderLogs() { renders++ },
    $: (id) => id === "log-search" ? input : button,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  button.onclick()
  assert.equal(sandbox.logQuery, "")
  assert.equal(sandbox.logFilters.size, 0, "the clear button drops the event filter too")
  assert.equal(sandbox.logChatFilters.size, 0, "chat filter is cleared as well")
  assert.equal(sandbox.logModelFilters.size, 0, "model filter is cleared as well")
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

test("the provider table shows the name and its actions, not baseURL or a model count", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("function renderProviders()"), providers.indexOf('$("p-checkins").onclick'))
  const box = { innerHTML: "", querySelectorAll: () => [] }
  const emptyBox = { innerHTML: "" }
  const checkins = { style: {} }
  const sandbox = {
    cfg: { providers: {
      alpha: { baseURL: "https://a.example/v1", models: ["m1", "m2"], homepage: "https://a.example" },
      beta: { baseURL: "https://b.example/v1", models: ["m3"], checkin: "https://b.example/checkin" },
    } },
    providersFilter: "",
    esc: (s) => String(s ?? ""),
    emptyStateHtml: (message) => `<div class="sessions-empty"><strong>${message}</strong></div>`,
    $: (id) => id === "providers" ? box : id === "providers-empty" ? emptyBox : checkins,
    openProviderDialog() {}, openUrl() {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("renderProviders()", sandbox)
  // A table row, one line per provider: the name with its icons right after it,
  // the URL in its own column and a bare edit icon at the end.
  assert.match(box.innerHTML, /<tr data-provider="alpha"/, "providers render as table rows")
  assert.match(box.innerHTML, /<th>имя<\/th><th>baseURL<\/th>/, "the URL has its own column")
  assert.match(box.innerHTML, /<b>alpha<\/b><span class="provider-links">/, "the action icons follow the name, not a separate column")
  assert.match(box.innerHTML, /data-a="edit"[^>]*aria-label="Изменить"/, "every row has an edit action")
  assert.doesNotMatch(box.innerHTML, /<span>Изменить<\/span>/, "the edit action is an icon, not a label")
  assert.match(box.innerHTML, /provider-url/, "the baseURL is shown")
  assert.doesNotMatch(box.innerHTML, /provider-card/, "no card markup")
  assert.doesNotMatch(box.innerHTML, />2</, "the model count is gone")
  assert.match(box.innerHTML, /data-a="homepage"/, "homepage link is kept")
  assert.match(box.innerHTML, /data-a="checkin"/, "checkin link is kept")
  sandbox.providersFilter = "b.example"
  vm.runInContext("renderProviders()", sandbox)
  assert.match(box.innerHTML, /data-provider="beta"/, "search still matches the hidden baseURL")
  assert.doesNotMatch(box.innerHTML, /data-provider="alpha"/)
  sandbox.providersFilter = "нет такого"
  vm.runInContext("renderProviders()", sandbox)
  assert.match(emptyBox.innerHTML, /ничего не найдено/)
  // The URL takes the free track, the name and icons stay on one line.
  const components = readFileSync(new URL("css/components.css", FRONTEND), "utf8")
  assert.match(components, /#providers th:nth-child\(2\)[^}]*width: 100%/, "the URL takes the free width")
  assert.match(components, /#providers th:not\(:nth-child\(2\)\)[^}]*white-space: nowrap/, "name and actions never wrap")
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
    tagPickerState: new Map(),
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
  const list = { innerHTML: "", classList: { toggle() {} }, querySelectorAll: () => [] }
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
    applyPmColumns: () => {},
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

test("model cards put the not-found badge before the image icon and context", () => {
  const shared = readFileSync(new URL("js/shared.js", FRONTEND), "utf8")
  const source = shared.slice(shared.indexOf("function modelCardsHtml"), shared.indexOf("/// Provider buttons"))
  const sandbox = {
    esc: (value) => String(value ?? ""),
    isImageModel: (_, id) => id === "img",
    imageIcon: () => "[IMAGE]",
    contextBadge: () => "[CTX]",
    availabilityBadge: () => "[MISSING]",
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const html = vm.runInContext('modelCardsHtml("p", ["img"])', sandbox)
  assert.ok(html.indexOf("[MISSING]") < html.indexOf("[IMAGE]"), "«не найдена» comes first")
  assert.ok(html.indexOf("[IMAGE]") < html.indexOf("[CTX]"), "the image icon comes before the context badge")
})

test("provider buttons show the selected model count only when asked", () => {
  const shared = readFileSync(new URL("js/shared.js", FRONTEND), "utf8")
  const source = shared.slice(shared.indexOf("function providerOptionsHtml"), shared.indexOf("/// Search field"))
  const sandbox = { esc: (value) => String(value ?? "") }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const plain = vm.runInContext('providerOptionsHtml(["alpha"], "alpha")', sandbox)
  assert.doesNotMatch(plain, /<small>/, "pickers without counts stay as they were")
  const counted = vm.runInContext('providerOptionsHtml(["alpha","beta"], "alpha", {alpha: 3, beta: 0})', sandbox)
  assert.match(counted, /alpha<\/strong><small>3<\/small>/, "the connections list ends with the ticked count")
  assert.match(counted, /beta<\/strong><small>0<\/small>/)
})

test("picking a provider keeps the typed model search", () => {
  const connections = readFileSync(new URL("js/connections.js", FRONTEND), "utf8")
  const source = connections.slice(connections.indexOf("function renderProviderModels"), connections.indexOf('// "Выбирать все автоматически"'))
  const options = { innerHTML: "", classList: { toggle() {}, add() {} }, buttons: [], querySelectorAll() { return this.buttons } }
  const list = { innerHTML: "", classList: { toggle() {} } }
  const current = { innerHTML: "" }
  const input = { value: "" }
  const providerInput = { value: "" }
  let loaded = null
  const sandbox = {
    cfg: { providers: { alpha: { models: ["m1"] }, beta: { models: ["m2"] } } },
    pmProviderFilter: "",
    pmState: { provider: "alpha", ids: ["m1"], filter: "deep", loading: false, error: null },
    providerOptionsHtml: (names) => {
      options.buttons = names.map((name) => ({ dataset: { provider: name } }))
      return names.join(",")
    },
    emptyStateHtml: (message) => message,
    isAutoAllProvider: () => false,
    pmCurrentLine() {},
    loadPmModels(name) { loaded = name },
    renderPmList() {},
    $: (id) => ({ "pm-provider-options": options, "pm-list": list, "pm-provider-current": current, "pm-filter": input, "pm-provider-filter": providerInput })[id],
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("renderProviderModels()", sandbox)
  options.buttons.find((button) => button.dataset.provider === "beta").onclick()
  const state = vm.runInContext("pmState", sandbox)
  assert.equal(state.provider, "beta")
  assert.equal(state.filter, "deep", "the model search survives the provider switch")
  assert.equal(loaded, "beta", "the new provider's catalog is fetched")
  // The provider search keeps working on its own.
  sandbox.pmProviderFilter = "alph"
  vm.runInContext("renderProviderModels()", sandbox)
  assert.equal(JSON.stringify(options.buttons.map((button) => button.dataset.provider)), '["alpha"]')
})

test("log facets collect chats and requested models from actual lines only", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("function logSessionId"), logs.indexOf("function logType"))
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('logSessionTitles = { ses_full1234: "Починить меню" }', sandbox)
  const lines = [
    "[2026-11-23 10:00:00] router → ответ: router (p/m) [ses:ses_full1234]",
    "[2026-11-23 10:00:01] deepseek-v4 → свитч: deepseek-v4 (p/m) — HTTP 429 [ses:ses_other]",
    "[2026-11-23 10:00:02] image images/generations p/flux → HTTP 400: bad",
    "[2026-11-23 10:00:03] GET /v1/models → 3 моделей",
  ]
  const facets = vm.runInContext(`JSON.stringify(logFacets(${JSON.stringify(lines)}))`, sandbox)
  const parsed = JSON.parse(facets)
  assert.deepEqual(parsed.models.sort(), ["deepseek-v4", "router"], "only names left of the arrow, no upstream and no HTTP lines")
  assert.deepEqual(parsed.chats.map((chat) => chat.id).sort(), ["ses_full1234", "ses_other"])
  const titled = parsed.chats.find((chat) => chat.id === "ses_full1234")
  assert.equal(titled.label, "Починить меню", "a known title replaces the raw id")
  assert.match(titled.tip, /ses_full1234/, "the tooltip keeps the full id")
  assert.equal(parsed.chats.find((chat) => chat.id === "ses_other").label, "ses_other", "without a title the id is shown")
})

test("the log facet list is ordered by last activity once per opening", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("function logSessionId"), logs.indexOf("function logFacetSelection"))
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('logSessionTitles = { ses_a: "Альфа", ses_b: "Бета" }', sandbox)
  // Newest first, as the log window is delivered: "бета" was active last, then
  // "Альфа", then the model nobody asked for alphabetically first.
  const lines = [
    "[2026-11-23 10:05:00] zeta → ответ: zeta (p/m) [ses:ses_b]",
    "[2026-11-23 10:04:00] alpha → ответ: alpha (p/m) [ses:ses_a]",
    "[2026-11-23 10:03:00] zeta → свитч: zeta (p/m) [ses:ses_a]",
  ]
  const snapshot = `const snap = logFacetOrderSnapshot(${JSON.stringify(lines)})
    JSON.stringify([[...snap.chats.keys()], [...snap.models.keys()]])`
  const [chatOrder, modelOrder] = JSON.parse(vm.runInContext(snapshot, sandbox))
  assert.deepEqual(chatOrder, ["ses_b", "ses_a"], "the chat active last leads")
  assert.deepEqual(modelOrder, ["zeta", "alpha"], "models follow the same rule, not the alphabet")

  // The snapshot, not the live lines, decides the order: a newer line arriving
  // while the menu is open must not reshuffle it.
  vm.runInContext(`logFacetOrder = logFacetOrderSnapshot(${JSON.stringify(lines)})`, sandbox)
  vm.runInContext(`logLines = ${JSON.stringify(["[2026-11-23 10:06:00] beta → ответ: beta (p/m) [ses:ses_c]", ...lines])}`, sandbox)
  const entries = (group) => JSON.parse(vm.runInContext(`JSON.stringify(logFacetEntries("${group}").map((entry) => entry.value))`, sandbox))
  assert.deepEqual(entries("chats").slice(-2), ["ses_b", "ses_a"], "a line that arrived after the opening does not reorder the list")
  assert.equal(entries("chats")[0], "ses_c", "but a brand-new chat still shows, ahead of the older ones")
  assert.deepEqual(entries("models").slice(-2), ["zeta", "alpha"])
})

test("log filters join groups with AND and values inside a group with OR", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("const LOG_PAGE_SIZE"), logs.indexOf("function logFilterActive"))
  const sandbox = { document: { addEventListener() {} } }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const answer = "[2026-11-23 10:00:00] router → ответ: router (p/m) [ses:a]"
  const switchLine = "[2026-11-23 10:00:01] other → свитч: other (p/m) — HTTP 429 [ses:b]"
  const match = (types, chats, models, line) => vm.runInContext(
    `logQuery = ""; logFilters = new Set(${JSON.stringify(types)}); logChatFilters = new Set(${JSON.stringify(chats)}); logModelFilters = new Set(${JSON.stringify(models)}); logMatches(${JSON.stringify(line)})`,
    sandbox)
  assert.equal(match([], [], [], answer), true, "no selection shows everything")
  assert.equal(match(["answer", "switch"], [], [], switchLine), true, "values inside one group are OR-ed")
  assert.equal(match(["answer"], [], [], switchLine), false)
  assert.equal(match(["answer"], ["a"], [], answer), true)
  assert.equal(match(["answer"], ["b"], [], answer), false, "groups are AND-ed")
  assert.equal(match([], [], ["router"], answer), true)
  assert.equal(match([], ["a"], ["other"], answer), false)
})

test("log facet pages hold six entries and search filters the list", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("function logPageSlice"), logs.indexOf("function logSessionId"))
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const models = Array.from({ length: 8 }, (_, i) => `model-${i + 1}`)
  sandbox.models = models
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(logPageSlice(models, 0, 6))", sandbox)), models.slice(0, 6))
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(logPageSlice(models, 1, 6))", sandbox)), models.slice(6))
  const filtered = vm.runInContext(`models.filter((model) => model.includes("model-3"))`, sandbox)
  assert.deepEqual(filtered, ["model-3"], "the mini search narrows the facet list")
})

test("a drag pick is staged until the pointer is released", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("function applyLogFacetDraft"), logs.indexOf("function logFacetEntries"))
  const release = logs.slice(logs.indexOf("function finishLogFacetDrag"), logs.indexOf("function renderLogs"))
  let renders = 0
  const sandbox = {
    logFilters: new Set(),
    logChatFilters: new Set(),
    logModelFilters: new Set(),
    logFacetDraft: { types: new Set(["answer"]), chats: new Set(["ses_a"]), models: new Set() },
    logFacetDrag: { view: "types", checked: true },
    logPage: 2,
    renderLogs() { renders++ },
    document: { addEventListener() {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(source + release, sandbox)
  assert.equal(sandbox.logFilters.size, 0, "staged ticks are not applied while the mouse is down")
  vm.runInContext("finishLogFacetDrag()", sandbox)
  assert.equal(JSON.stringify([...sandbox.logFilters]), '["answer"]', "release applies the whole draft at once")
  assert.equal(JSON.stringify([...sandbox.logChatFilters]), '["ses_a"]', "the other groups apply together")
  assert.equal(sandbox.logPage, 0, "a new filter starts from the newest page")
  assert.equal(renders, 1, "one redraw for the whole drag")
  assert.equal(sandbox.logFacetDrag, null)
})

test("log search also matches the session title", () => {
  const logs = readFileSync(new URL("js/logs.js", FRONTEND), "utf8")
  const source = logs.slice(logs.indexOf("const LOG_PAGE_SIZE"), logs.indexOf("function renderLogs"))
  const sandbox = { document: { addEventListener() {} } }
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

test("a tag keeps its colour and a rename rewrites every reference", () => {
  const source = scripts.slice(scripts.indexOf("function tagColor("), scripts.indexOf("// --- Tag registry dialog"))
  const sandbox = {
    cfg: {
      tags: ["быстрый", "дешёвый"],
      models: { chain: { upstreams: [], tags: ["быстрый"] }, other: { upstreams: [], tags: ["дешёвый", "быстрый"] } },
      opencodeModels: { p: { models: ["m"], tags: ["дешёвый"] } },
    },
    esc: (s) => String(s ?? ""),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const colour = (name) => vm.runInContext(`tagColor(${JSON.stringify(name)})`, sandbox)
  assert.equal(colour("быстрый"), colour("быстрый"), "the same tag keeps one colour")
  assert.notEqual(colour("быстрый"), colour("дешёвый"), "different tags differ")
  assert.match(vm.runInContext("tagChipsHtml(['быстрый'])", sandbox), /class="tag-chip"/)

  // Rename the first tag: every holder follows, nothing points at the old name.
  vm.runInContext("applyTagRegistry(['скорый', 'дешёвый'])", sandbox)
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.models.chain.tags)", sandbox)), ["скорый"])
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.models.other.tags)", sandbox)), ["дешёвый", "скорый"])
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.opencodeModels.p.tags)", sandbox)), ["дешёвый"])
  // Dropping a tag removes it from the cards and empties arrays disappear.
  vm.runInContext("applyTagRegistry(['скорый'])", sandbox)
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.models.other.tags)", sandbox)), ["скорый"], "a surviving tag stays")
  assert.equal(vm.runInContext("'tags' in cfg.opencodeModels.p", sandbox), false, "an emptied tag list is not saved")
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(cfg.tags)", sandbox)), ["скорый"])
  // Filter group: OR inside, and an empty selection shows everything.
  const matches = (tags, selected) => vm.runInContext(
    `tagFilterMatches(${JSON.stringify(tags)}, new Set(${JSON.stringify(selected)}))`, sandbox)
  assert.equal(matches(["a"], []), true, "no picked tag shows everything")
  assert.equal(matches(["a", "b"], ["b"]), true, "any picked tag matches")
  assert.equal(matches(["a"], ["b"]), false)
})

test("the tag filter hides cards without a picked tag and cards show their chips", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("function renderModels()"), providers.indexOf("// The steps inside every chain"))
  const box = { innerHTML: "", querySelectorAll: () => [], append() {}, querySelector: () => null }
  const sandbox = {
    cfg: {
      tags: ["быстрый", "дешёвый"],
      models: {
        fast: { upstreams: [{ provider: "p", model: "m" }], tags: ["быстрый"] },
        cheap: { upstreams: [{ provider: "p", model: "m" }], tags: ["дешёвый"] },
        plain: { upstreams: [{ provider: "p", model: "m" }] },
      },
      providers: { p: { models: ["m"] } },
    },
    modelSearch: "",
    chainFilters: new Set(),
    chainTags: new Set(),
    esc: (s) => String(s ?? ""),
    tagChipsHtml: (tags) => (tags ?? []).map((tag) => `<span class="tag-chip">${tag}</span>`).join(""),
    tagFilterMatches: (tags, selected) => !selected?.size || (tags ?? []).some((tag) => selected.has(tag)),
    chainContextBadge: () => "",
    debugLog() {},
    applyStepColumns() {},
    renderTagCategoryBar() {},
    syncFilterButton() {},
    emptyStateHtml: (message) => `<div class="sessions-empty">${message}</div>`,
    document: { createElement: () => ({ dataset: {}, querySelector: () => ({ onclick: null }), set innerHTML(v) { this.html = v }, append() {} }) },
    $: () => box,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  // The renderer creates each card and sets its innerHTML; capture that markup.
  vm.runInContext(
    `const created = []
     document.createElement = () => { const el = { dataset: {}, querySelector: () => ({ onclick: null }), append() {}, set innerHTML(v) { this.html = v; created.push(v) } }; return el }
     this.created = created`,
    sandbox,
  )
  const html = () => { vm.runInContext("created.length = 0; renderModels()", sandbox); return vm.runInContext("created.join('')", sandbox) }
  vm.runInContext("chainTags = new Set(['быстрый'])", sandbox)
  const onlyFast = html()
  assert.match(onlyFast, /fast/, "the tagged chain stays")
  assert.doesNotMatch(onlyFast, /plain/, "an untagged chain is hidden")
  assert.match(onlyFast, /<span class="tag-chip">быстрый<\/span>/, "the card shows its tag chip")
  vm.runInContext("chainTags = new Set(['быстрый','дешёвый'])", sandbox)
  const both = html()
  assert.match(both, /cheap/, "tags inside the group are OR-ed")
  vm.runInContext("chainTags.clear()", sandbox)
  assert.match(html(), /plain/, "no picked tag shows every chain")
})

test("the tag category row follows the setting and filters on one click", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("function renderTagCategoryBar"), providers.indexOf("function renderModels()"))
  const makeBox = () => {
    const chips = []
    return {
      hidden: false,
      html: "",
      set innerHTML(v) {
        this.html = v
        chips.length = 0
        for (const m of v.matchAll(/data-tag="([^"]+)"/g)) chips.push({ dataset: { tag: m[1] }, onclick: null })
      },
      get innerHTML() { return this.html },
      querySelectorAll: () => chips,
      chips,
    }
  }
  let enabled = true
  let box = makeBox()
  const sandbox = {
    picked: [],
    cfg: { tags: ["быстрый", "дешёвый"] },
    appSettings: () => ({ tagCategories: enabled }),
    tagRegistryNames: () => ["быстрый", "дешёвый"],
    tagColor: () => "#000",
    esc: (v) => String(v ?? ""),
    $: () => box,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const draw = () => vm.runInContext(`renderTagCategoryBar("bar", new Set(picked), (tag) => { picked.push(tag) })`, sandbox)

  // Off by default: the row keeps no chips at all, so it cannot steal a click.
  enabled = false
  draw()
  assert.equal(box.hidden, true, "the setting hides the row")
  assert.equal(box.innerHTML, "", "a hidden row renders nothing")
  enabled = true
  draw()
  assert.equal(box.hidden, false)
  assert.equal(box.chips.length, 2, "one chip per registry tag")
  // A click picks the tag through the same filter set the flyout uses.
  box.chips[1].onclick()
  assert.deepEqual(sandbox.picked, ["дешёвый"])
  draw()
  assert.match(box.innerHTML, /class="tag-chip tag-toggle is-on" data-tag="дешёвый"/, "the picked chip stays lit")
})

test("the uptime button appears only for a provider with a script and draws its bars", async () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("function renderProviders()"), providers.indexOf('$("p-checkins").onclick'))
  const box = { innerHTML: "", querySelectorAll: () => [] }
  const sandbox = {
    cfg: { providers: {
      scripted: { baseURL: "https://a.example/v1", models: ["m"], uptimeScript: "print(1)" },
      plain: { baseURL: "https://b.example/v1", models: ["m"] },
    } },
    providersFilter: "",
    esc: (s) => String(s ?? ""),
    emptyStateHtml: () => "",
    $: (id) => id === "providers" ? box : { style: {}, innerHTML: "" },
    openProviderDialog() {}, openUrl() {}, openUptimeDialog() {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext("renderProviders()", sandbox)
  const rows = box.innerHTML.split("<tr data-provider=")
  const scripted = rows.find((html) => html.startsWith('"scripted"'))
  const plain = rows.find((html) => html.startsWith('"plain"'))
  assert.match(scripted, /data-a="uptime"/, "a script adds the uptime button")
  assert.doesNotMatch(plain, /data-a="uptime"/, "without a script there is no dead button")

  // The dialog maps the script's answer onto the shared bar markup.
  const uptime = readFileSync(new URL("js/uptime.js", FRONTEND), "utf8")
  const draw = uptime.slice(uptime.indexOf("async function loadUptime"), uptime.indexOf('$("uptime-refresh").onclick'))
  const body = { innerHTML: "" }
  const meta = { textContent: "" }
  const drawSandbox = {
    uptimeProvider: "p",
    esc: (s) => String(s ?? ""),
    plural: (n, one, few, many) => `${n} ${one}`,
    apiErrorMessage: (payload, fallback) => payload?.error?.message ?? fallback,
    api: async () => ({ ok: true, status: 200, json: async () => ({ bars: [
      { label: "m1", percent: 99.5 },
      { label: "m2", percent: 40 },
    ] }) }),
    $: (id) => (id === "uptime-body" ? body : meta),
  }
  vm.createContext(drawSandbox)
  vm.runInContext(draw, drawSandbox)
  await vm.runInContext("loadUptime()", drawSandbox)
  assert.match(body.innerHTML, /m1/, "every bar is drawn")
  assert.match(body.innerHTML, /99\.5%/, "the percentage is shown as the script reported it")
  assert.match(body.innerHTML, /token-fill success/, "a healthy model gets the success colour")
  assert.match(body.innerHTML, /token-fill error/, "a low one gets the problem colour")
  assert.match(meta.textContent, /2 модель/, "the header counts the bars")
})

test("changing the auth token saves under the old token, then switches", async () => {
  // The token form used to swap the local token before the PUT, so the save
  // itself returned 401 and every request after it did too. The save must go
  // out with the token the server still knows.
  const source = scripts.slice(
    scripts.indexOf("let pendingAuth = null"),
    scripts.indexOf("function modelHasLocalReference"),
  )
  const requests = []
  let saved = 0
  let savePromise = Promise.resolve()
  const sandbox = {
    cfg: { authToken: "", authTokenConfigured: true, models: {} },
    token: "old",
    localStorage: { items: {}, setItem(k, v) { this.items[k] = v }, getItem(k) { return this.items[k] ?? null } },
    api: async (path, opts) => {
      requests.push({ path, auth: sandbox.token, body: JSON.parse(opts.body) })
      return { ok: sandbox.nextSaveOk !== false, status: 200, json: async () => ({}) }
    },
    renderSettings() { saved++ },
    flash() {},
    debugLog() {},
    $: () => ({}),
    // Stands in for the debounced save: one PUT, then the settle call.
    save() {
      savePromise = (async () => {
        const r = await sandbox.api("/api/config", { method: "PUT", body: JSON.stringify(sandbox.cfg) })
        sandbox.settlePendingAuth(r.ok)
      })()
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source + "\nthis.setAuthToken = setAuthToken; this.settlePendingAuth = settlePendingAuth", sandbox)
  vm.runInContext("setAuthToken('new')", sandbox)

  await savePromise
  assert.equal(requests.length, 1)
  assert.equal(requests[0].auth, "old", "the PUT uses the token the server still accepts")
  assert.equal(requests[0].body.authToken, "new", "the config carries the new token")
  assert.equal(sandbox.token, "new", "a successful save switches the GUI token")
  assert.equal(sandbox.localStorage.items.pp_token, "new")
  assert.equal(sandbox.cfg.authToken, "", "the saved token is no longer echoed in the field")
  assert.equal(sandbox.cfg.authTokenConfigured, true)

  // A rejected save must not leave the GUI claiming the token changed.
  sandbox.cfg = { authToken: "", authTokenConfigured: true, models: {} }
  sandbox.token = "old"
  sandbox.nextSaveOk = false
  vm.runInContext("setAuthToken('never-saved')", sandbox)
  await savePromise
  assert.equal(sandbox.token, "old", "a failed save keeps the working token")
  assert.equal(sandbox.cfg.authTokenConfigured, true, "the field falls back to 'token configured'")
  assert.equal(saved, 2, "the form is re-rendered after the save and after the failure")
})

test("the settings token field goes through the deferred save", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const handler = providers.slice(providers.indexOf('$("s-auth").onchange'), providers.indexOf('$("u-session-search").oninput'))
  assert.match(handler, /setAuthToken\(/, "the field must not swap the token itself")
  assert.doesNotMatch(handler, /localStorage\.setItem/, "the token switch happens only after a successful save")
})

test("provider and model rows show tokens per second from their own stream time", () => {
  const usage = readFileSync(new URL("js/usage.js", FRONTEND), "utf8")
  const source = usage.slice(usage.indexOf("function usageCompactTable"), usage.indexOf("function usageTable"))
  const table = (obj) => {
    const sandbox = {
      esc: (s) => String(s ?? ""),
      fmtNum: (n) => String(n ?? 0),
      fmtTok: (n) => String(n ?? 0),
      problemColor: () => "green",
      fmtSpeed: (tokens, ms) => {
        const seconds = (Number(ms) || 0) / 1000
        return seconds > 0 ? ((Number(tokens) || 0) / seconds).toFixed(1) : "-"
      },
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    return vm.runInContext(`usageCompactTable(${JSON.stringify(obj)})`, sandbox)
  }
  const html = table({
    fast: { requests: 2, ok: 2, tokensIn: 100, tokensOut: 500, streamMs: 1000 },
    never: { requests: 1, ok: 1, tokensIn: 10, tokensOut: 0 },
  })
  assert.match(html, /<th>Запросы<\/th><th>Ток\/с<\/th>/, "speed follows the request count")
  assert.match(html, /500\.0\/с/, "speed is output tokens over that row's stream time")
  // A row that never streamed shows a dash rather than a misleading 0.0.
  assert.match(html, /<td class="muted">-<\/td>/)
})

test("the images panel has two separate last-model cards and no history table", () => {
  assert.doesNotMatch(indexHtml, /u-image-recent/, "the mixed block is gone")
  assert.doesNotMatch(indexHtml, /id="u-images"/, "the history table is gone")
  assert.match(indexHtml, /id="u-image-last-generate"/)
  assert.match(indexHtml, /id="u-image-last-edit"/)
  const usage = readFileSync(new URL("js/usage.js", FRONTEND), "utf8")
  const drawer = usage.slice(usage.indexOf('$("u-image-last-generate")'), usage.indexOf("// The 3-second poll"))
  assert.match(drawer, /Последняя модель для генерации/)
  assert.match(drawer, /Последняя модель для редактирования/)
  assert.doesNotMatch(drawer, /recentImages/, "the history list is not rendered")
  // The two cards sit on one row when there is room and stack when there is not.
  assert.match(styles, /\.last-models \{[^}]*auto-fit/, "the block is responsive")
})

test("the information group holds logs, statistics and uptime", () => {
  assert.match(indexHtml, /<span>Информация<\/span>/, "the group is renamed")
  assert.doesNotMatch(indexHtml, /Статистика и логи/)
  assert.match(indexHtml, /data-tab="uptime"/)
  const uptime = readFileSync(new URL("js/uptime.js", FRONTEND), "utf8")
  assert.match(uptime, /renderUptimeTab/, "the tab draws its placeholders")
  // Both views are placeholders, and neither fetches anything yet.
  const tab = uptime.slice(uptime.indexOf("function renderUptimeTab"))
  assert.match(tab, /в разработке/)
  assert.doesNotMatch(tab, /api\(/, "the placeholder makes no requests")
  assert.match(indexHtml, /data-uptime-group="providers"/)
  assert.match(indexHtml, /data-uptime-group="models"/)
})

test("the provider dialog hides optional fields and picks the uptime script from a file", () => {
  const providers = readFileSync(new URL("js/dialogs-provider.js", FRONTEND), "utf8")
  const htmlBlock = indexHtml.slice(indexHtml.indexOf('id="dlg-provider"'), indexHtml.indexOf('id="dlg-model"'))
  assert.match(htmlBlock, /<details id="dp-more"/, "optional fields fold away")
  assert.match(htmlBlock, /id="dp-uptime-file" type="file"/, "the script is a file input")
  assert.doesNotMatch(htmlBlock, /id="dp-uptime"/, "the code textarea is gone")
  // The three required fields stay outside the fold.
  const beforeFold = htmlBlock.slice(0, htmlBlock.indexOf("<details"))
  for (const id of ["dp-name", "dp-url", "dp-key"]) assert.match(beforeFold, new RegExp(`id="${id}"`), `${id} stays visible`)
  assert.match(providers, /uptimeScriptFile/, "the picked file name is stored")
  assert.match(providers, /file\.text\(\)/, "the file content becomes the script")
  // Clearing removes both halves, so no dead button is left behind.
  const clear = providers.slice(providers.indexOf('$("dp-uptime-clear").onclick'), providers.indexOf('$("dp-delete").onclick'))
  assert.match(clear, /uptimeDraft = \{ script: "", file: "" \}/)
})

test("the config preview shows two rows and hides the toggle when nothing else is left", async () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("const previewEntries = new Map()"), providers.indexOf(" function renderOpenCode() {"))
  const run = (tops, expanded = false) => {
    const chips = tops.map((top) => ({ offsetTop: top, hidden: false }))
    let toggle = null
    const box = {
      querySelectorAll: () => chips,
      querySelector: () => toggle,
      append: (node) => { toggle = node },
    }
    const sandbox = {
      $: () => box,
      esc: (s) => String(s ?? ""),
      previewExpanded: { has: () => expanded, add() {}, delete() {} },
      renderOpenCode() {},
      document: { createElement: () => ({ classList: {}, remove() {} }) },
    }
    vm.createContext(sandbox)
    vm.runInContext(source + "\nthis.fit = fitPreviewRows", sandbox)
    // `previewEntries` lives in the slice, so fill it from inside that context.
    vm.runInContext(`previewEntries.set("oc-preview", ${JSON.stringify(tops.map((_, i) => [`m${i}`, ""]))})`, sandbox)
    vm.runInContext(`fit("oc-preview", ${expanded})`, sandbox)
    return { chips, toggle }
  }
  // Two rows of three: everything fits, no dead "показать ещё".
  const fits = run([0, 0, 0, 40, 40, 40])
  assert.equal(fits.chips.filter((chip) => !chip.hidden).length, 6)
  assert.equal(fits.toggle, null, "no toggle when every chip is already visible")

  // A third row is folded away and the toggle counts only what is hidden.
  const folded = run([0, 0, 0, 40, 40, 40, 80, 80])
  assert.deepEqual(folded.chips.map((chip) => chip.hidden), [false, false, false, false, false, false, true, true])
  assert.match(folded.toggle.innerHTML, /Показать ещё 2/)

  // Expanded means no hidden chips at all; the toggle only collapses.
  const expanded = run([0, 0, 0, 40, 40, 40, 80], true)
  assert.equal(expanded.chips.filter((chip) => chip.hidden).length, 0)
  assert.match(expanded.toggle.innerHTML, /Свернуть/)
})

test("the filter flyout ticks its own filters and the hint sits above the button", () => {
  // `checks` is an array; reading `checks.checked` threw the interface error on
  // every filter open ("checks.checked is not a function").
  const tags = readFileSync(new URL("js/tags.js", FRONTEND), "utf8")
  const flyout = tags.slice(tags.indexOf("function openTagFilterMenu"), tags.indexOf("// --- Tag registry dialog"))
  assert.match(flyout, /\$\{checked\(value\) \? "checked" : ""\}/, "the checkbox state comes from the checked callback")
  assert.doesNotMatch(flyout, /checks\.checked/)

  const core = readFileSync(new URL("js/core.js", FRONTEND), "utf8")
  const hint = core.slice(core.indexOf("function showFieldHint"), core.indexOf("function hideFieldHint"))
  assert.match(hint, /above/, "the hint prefers the space above the button")
  assert.doesNotMatch(hint, /let left = anchor\.right \+ 8/, "it no longer opens beside the button over a neighbour")
})

test("the tag row keeps one line and the search brings the hidden tags back", () => {
  const tags = readFileSync(new URL("js/tags.js", FRONTEND), "utf8")
  const source = tags.slice(tags.indexOf("const tagPickerState = new Map()"), tags.indexOf("function wireTagPicker"))
  const run = (names, room, query = "") => {
    const chips = names.map((tag) => ({ dataset: { tag }, offsetWidth: 30, hidden: false }))
    const empty = { hidden: true }
    const list = { clientWidth: room, querySelectorAll: () => chips, querySelector: () => empty }
    const sandbox = {
      $: () => ({ querySelector: (selector) => (selector === ".tag-picker-list" ? list : null) }),
      esc: (s) => String(s ?? ""),
      tagRegistryNames: () => names,
    }
    vm.createContext(sandbox)
    vm.runInContext(source + "\nthis.sync = syncTagPicker", sandbox)
    vm.runInContext(`tagPickerState.set("dm-tags", { query: ${JSON.stringify(query)}, search: false })`, sandbox)
    vm.runInContext('sync("dm-tags")', sandbox)
    return { chips, empty }
  }
  // 100px holds two 30px chips plus their gaps; the rest fold away.
  const narrow = run(["a1", "b2", "c3", "d4"], 100)
  assert.deepEqual(narrow.chips.map((chip) => chip.hidden), [false, false, true, true])
  assert.equal(narrow.empty.hidden, true, "there is still something to show")
  // The query decides visibility, not just the width: a chip that was folded
  // away is the one the search brings back.
  const found = run(["a1", "b2", "c3", "d4"], 100, "d4")
  assert.deepEqual(found.chips.map((chip) => chip.hidden), [true, true, true, false])
  // No match means the empty line, not a blank row.
  const none = run(["a1"], 100, "zz")
  assert.equal(none.chips[0].hidden, true)
  assert.equal(none.empty.hidden, false)
  // A closed dialog reports no width; nothing must be hidden before it opens.
  assert.equal(run(["a1", "b2", "c3", "d4"], 0).chips.filter((chip) => !chip.hidden).length, 4)
})

test("the tag flyout pages through the registry and offers the editor", () => {
  const tags = readFileSync(new URL("js/tags.js", FRONTEND), "utf8")
  const source = tags.slice(tags.indexOf("const TAG_FACET_PAGE_SIZE"), tags.indexOf("// --- Tag registry dialog"))
  const registry = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"]
  const makeMenu = () => ({
    className: "",
    _html: "",
    _buttons: [],
    get innerHTML() { return this._html },
    set innerHTML(value) {
      this._html = value
      this._buttons = []
      for (const m of value.matchAll(/data-view="([^"]+)"/g)) this._buttons.push({ selector: "[data-view]", dataset: { view: m[1] } })
      for (const m of value.matchAll(/data-facet-page="(-?\d+)"/g)) this._buttons.push({ selector: "[data-facet-page]", dataset: { facetPage: m[1] } })
      if (value.includes("data-tag-search-toggle")) this._buttons.push({ selector: "[data-tag-search-toggle]", dataset: {} })
      if (value.includes("data-tag-manage")) this._buttons.push({ selector: "[data-tag-manage]", dataset: {} })
      if (value.includes("log-facet-search")) this._buttons.push({ selector: ".log-facet-search", dataset: {}, focus() {}, addEventListener() {} })
    },
    querySelectorAll(selector) { return this._buttons.filter((button) => button.selector === selector) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
  })
  const menu = makeMenu()
  const sandbox = {
    tagRegistryNames: () => registry,
    tagColor: () => "#000",
    esc: (s) => String(s ?? ""),
    TAG_SEARCH_ICON: "",
    TAG_EDIT_ICON: "",
    searchMenu: menu,
    openSearchMenuContent: (_anchor, render) => render(menu),
    positionSearchMenu() {},
    openTagRegistry() {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source + "\nthis.open = openTagFilterMenu", sandbox)
  vm.runInContext('open({}, { tagSet: new Set(["b2"]) })', sandbox)
  const click = (selector, data) => menu.querySelectorAll(selector).find((button) => Object.entries(data).every(([key, value]) => button.dataset[key] === value)).onclick()
  click("[data-view]", { view: "tags" })
  // Six per page: the seventh waits for the next page.
  assert.match(menu.innerHTML, /a1[\s\S]*f6/)
  assert.doesNotMatch(menu.innerHTML, /g7/)
  assert.match(menu.innerHTML, /data-tag-manage/, "the editor sits next to the pager")
  assert.doesNotMatch(menu.innerHTML, /data-facet-page="1"[^>]*disabled/, "there is a second page to go to")
  click("[data-facet-page]", { facetPage: "1" })
  assert.match(menu.innerHTML, /g7[\s\S]*h8/)
  assert.doesNotMatch(menu.innerHTML, /a1/)
  assert.match(menu.innerHTML, /data-facet-page="1"[^>]*disabled/, "the last page stops the pager")
})

test("the all-sessions pager shares the action row and the tables no longer scroll sideways", () => {
  // Paging used to hide behind a "Страницы" drawer; it now sits in the footer
  // next to "Закрыть", so it is always one click away.
  const dialog = indexHtml.slice(indexHtml.indexOf('id="dlg-all-sessions"'), indexHtml.indexOf('id="dlg-model-settings"'))
  const actions = dialog.slice(dialog.indexOf('<div class="dialog-actions">'))
  assert.match(actions, /id="all-sessions-pager"[\s\S]*Закрыть/, "the pager sits in the action row")
  assert.doesNotMatch(dialog, /pager-drawer/, "the drawer is gone")
  assert.doesNotMatch(scripts, /all-sessions-drawer-toggle/, "no handler is left for the removed drawer")

  // The statistics tables take the panel width; only the name column gives way.
  assert.match(styles, /#u-providers, #u-models \{ width: 100%; table-layout: fixed; \}/)
  assert.doesNotMatch(styles, /#u-providers, #u-models \{ display: block; overflow-x: auto; \}/)

  // Two tabs (chains/Models) now fill the row like three do in the logs.
  assert.match(styles, /\.log-filter-tabs \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\)/)
  // The chain editor is a single column, whatever the pane width.
  assert.match(styles, /\.chain-editor \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/)
  assert.doesNotMatch(scripts, /applyChainColumns/, "the column fitting code is gone")
})

test("the tag registry searches and pages without losing the row it edits", () => {
  const tags = readFileSync(new URL("js/tags.js", FRONTEND), "utf8")
  const source = tags.slice(tags.indexOf("let tagRegistryPage = 0"), tags.indexOf("function addTagFromField"))
  const rows = (html) => [...html.matchAll(/data-tag-index="(\d+)"[\s\S]*?class="tag-registry-input" value="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]])
  const make = (names) => {
    const list = { innerHTML: "" }
    const pager = { hidden: false, innerHTML: "", _buttons: [], querySelectorAll: () => [] }
    const chip = { textContent: "", style: { setProperty() {} } }
    const sandbox = {
      tagDraft: names,
      tagRegistryPage: 0,
      tagRegistryQuery: "",
      esc: (s) => String(s ?? ""),
      tagColor: () => "#000",
      tagRegistryNames: () => names,
      emptyInlineHtml: (message) => `<div class="empty-inline">${message}</div>`,
      $: (id) => (id === "tags-list" ? list : id === "tags-pager" ? pager : {}),
      document: { querySelectorAll: () => [] },
    }
    // Rows are built as markup, so the per-row handlers need element stubs.
    list.querySelectorAll = () => rows(list.innerHTML).map(([index, value]) => ({
      dataset: { tagIndex: String(index) },
      querySelector: (selector) => (selector === ".tag-chip" ? chip : { oninput: null, onclick: null, value }),
    }))
    vm.createContext(sandbox)
    vm.runInContext(source + "\nthis.render = renderTagRegistry", sandbox)
    return { sandbox, list, pager }
  }
  const many = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8", "i9"]
  const first = make(many)
  first.sandbox.render()
  assert.deepEqual(rows(first.list.innerHTML).map(([, value]) => value), ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"], "eight per page")
  assert.equal(first.pager.hidden, false, "nine tags need a pager")
  // The second page keeps the draft indexes, so a delete hits the right tag.
  vm.runInContext("tagRegistryPage = 1", first.sandbox)
  first.sandbox.render()
  assert.deepEqual(rows(first.list.innerHTML), [[8, "i9"]])
  // The search filters the whole draft and resets paging.
  vm.runInContext('tagRegistryQuery = "f"; tagRegistryPage = 0', first.sandbox)
  first.sandbox.render()
  assert.deepEqual(rows(first.list.innerHTML), [[5, "f6"]])
  // A query with no hit says so instead of drawing an empty list.
  vm.runInContext('tagRegistryQuery = "zzz"', first.sandbox)
  first.sandbox.render()
  assert.match(first.list.innerHTML, /ничего не найдено/)
})

test("the skills dialog lists installed skills and keeps a placeholder browser", () => {
  assert.match(indexHtml, /id="integrations-advanced"[^>]*>Скиллы</, "the button is named Скиллы")
  assert.doesNotMatch(indexHtml, /Расширенные настройки/)
  assert.match(indexHtml, /data-skills-tab="installed"[^>]*>Установленные</)
  assert.match(indexHtml, /data-skills-tab="browse"[^>]*>Браузер</)
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const dialog = providers.slice(providers.indexOf("function renderSkillsDialog"), providers.indexOf('$("image-settings-cancel")'))
  assert.match(dialog, /emptyInlineHtml\("в разработке"\)/, "the browser tab is a placeholder")
  // The image skill lives in the Opencode card again; the dialog lists it too,
  // so both copies must follow the same state.
  assert.match(indexHtml, /id="oc-preview"[\s\S]*image-skill-install/, "the card carries the install button")
  assert.match(providers, /querySelectorAll\("\.image-skill-status"\)/, "both copies update together")
})

test("the hint opens above the button instead of over its neighbour", () => {
  const core = readFileSync(new URL("js/core.js", FRONTEND), "utf8")
  const source = core.slice(core.indexOf("function showFieldHint"), core.indexOf("function hideFieldHint"))
  const place = (buttonRect, viewport = { innerWidth: 700, innerHeight: 400 }) => {
    const hint = {
      hidden: true,
      textContent: "",
      innerHTML: "",
      style: {},
      parentElement: null,
      // A 140x30 tooltip: the sizes the clamp uses.
      getBoundingClientRect: () => ({ width: 140, height: 30 }),
    }
    const button = {
      dataset: { tip: "Очистить" },
      getBoundingClientRect: () => buttonRect,
      closest: () => null,
    }
    const sandbox = { fieldHint: hint, window: viewport, document: { body: { append() {} } }, button }
    vm.createContext(sandbox)
    vm.runInContext(source + "\nthis.showFieldHint = showFieldHint", sandbox)
    vm.runInContext("showFieldHint(button)", sandbox)
    return { top: Number.parseFloat(hint.style.top), left: Number.parseFloat(hint.style.left), height: 30, width: 140 }
  }
  // A clear icon in a mid-page toolbar with "Добавить" right after it: the hint
  // used to open beside the icon, on top of the neighbouring button.
  const bar = { left: 587, right: 617, top: 200, bottom: 230, width: 30, height: 30 }
  const hint = place(bar)
  assert.ok(hint.top + hint.height <= bar.top, `the hint sits above the button (top ${hint.top})`)
  assert.ok(hint.top >= 8, "and stays inside the window")

  // At the very top there is no room above, so it drops below the button
  // instead of covering it.
  const topBar = place({ ...bar, top: 16, bottom: 46 })
  assert.ok(topBar.top >= 46, `the hint drops below when the top is tight (top ${topBar.top})`)
})

test("the images panel renders its tiles from the day's image entries", () => {
  // `imageEntries` was dropped while the history table was removed, and every
  // statistics render threw a ReferenceError before painting the panel.
  const usage = readFileSync(new URL("js/usage.js", FRONTEND), "utf8")
  const report = usage.slice(usage.indexOf("function renderUsageReport"), usage.indexOf("// The 3-second poll"))
  const declared = report.indexOf("const imageEntries = Object.entries(u.images")
  const used = report.indexOf("imageEntries.reduce")
  assert.ok(declared > 0, "the image entries are computed")
  assert.ok(declared < used, "and before the tiles that use them")
})

test("the skills dialog lists every skill folder, not only the bundled one", () => {
  const providers = readFileSync(new URL("js/providers.js", FRONTEND), "utf8")
  const source = providers.slice(providers.indexOf("let skillsList = null"), providers.indexOf('$("image-settings-cancel")'))
  const panels = { installed: {}, browse: {} }
  const dialog = {
    open: true,
    querySelector: (selector) => panels[selector.includes("installed") ? "installed" : "browse"],
  }
  const sandbox = {
    api: async () => ({ ok: true, json: async () => ({ skills: [] }) }),
    apiErrorMessage: (payload, fallback) => fallback,
    imageSkillErrorMessage: (message) => message,
    imageSkillState: {},
    emptyInlineHtml: (message) => `<div class="empty-inline">${message}</div>`,
    esc: (s) => String(s ?? ""),
    dlgSkills: dialog,
  }
  vm.createContext(sandbox)
  vm.runInContext(source + "\nthis.render = renderSkillsDialog; this.set = (list) => { skillsList = list }", sandbox)
  vm.runInContext(`set([
    { name: "debugging", description: "Find the cause", path: "/s/debugging/SKILL.md", bundled: false },
    { name: "image-generation", description: "", path: "/s/image-generation/SKILL.md", bundled: true },
  ])`, sandbox)
  vm.runInContext("render()", sandbox)
  const html = panels.installed.innerHTML
  assert.match(html, /<h4>debugging<\/h4>/, "a skill that is not image-generation is listed")
  assert.match(html, /Find the cause/, "its frontmatter description is shown")
  assert.match(html, /<h4>image-generation<\/h4>/, "the bundled skill is listed too")
  assert.match(html, /\/s\/debugging\/SKILL.md/, "each row keeps its path")
  assert.match(panels.browse.innerHTML, /в разработке/, "browser stays a placeholder")

  // An empty or unreadable folder is a message, not a blank panel.
  vm.runInContext("set([]); render()", sandbox)
  assert.match(panels.installed.innerHTML, /ничего нет/)
  vm.runInContext("skillsError = 'нет доступа'; render()", sandbox)
  assert.match(panels.installed.innerHTML, /нет доступа/)
})

test("the provider dialog reveals the key and aligns the file row", () => {
  assert.match(
    indexHtml,
    /<input id="dp-key" type="password"[^>]*>\s*<button type="button" id="dp-key-reveal"/,
    "the eye sits inside the key field",
  )
  const dialogs = readFileSync(new URL("js/dialogs-provider.js", FRONTEND), "utf8")
  assert.match(dialogs, /function setKeyRevealed/, "one place toggles the field type")
  assert.match(dialogs, /setKeyRevealed\(false\)/, "the dialog reopens with the key hidden")
  const reveal = dialogs.slice(dialogs.indexOf("function setKeyRevealed"), dialogs.indexOf('$("dp-key-reveal").onclick'))
  assert.doesNotMatch(reveal, /\.value\s*=/, "revealing only flips the field type")

  // The uptime caption is a plain block, not a `label`, so it needs the label
  // typography by hand or it renders in the body's colour and size.
  const components = readFileSync(new URL("css/components.css", FRONTEND), "utf8")
  assert.match(components, /\.field-block \{[^}]*font-size: 12px[^}]*color: var\(--muted\)/, "the uptime caption matches the other labels")
})

test("the image skill dialog says the default model is used when the skill runs", () => {
  const help = indexHtml.slice(indexHtml.indexOf('id="image-settings-help"'), indexHtml.indexOf("</p>", indexHtml.indexOf('id="image-settings-help"')))
  assert.match(help, /по умолчанию/)
  assert.match(help, /при запуске skill/, "the dialog explains the skill uses it too")
})

test("the eye button flips the key field between password and text", () => {
  const dialogs = readFileSync(new URL("js/dialogs-provider.js", FRONTEND), "utf8")
  const source = dialogs.slice(dialogs.indexOf("function setKeyRevealed"), dialogs.indexOf('$("dp-uptime-file").onchange'))
  const input = { type: "password" }
  const button = {
    dataset: {},
    setAttribute(key, value) { this[key] = value },
  }
  // Every id gets its own node: one shared stub let `dp-cancel` overwrite the
  // eye's handler and the test proved nothing.
  const nodes = { "dp-key": input, "dp-key-reveal": button }
  const sandbox = {
    $: (id) => nodes[id] ?? (nodes[id] = { dataset: {}, setAttribute() {} }),
    openProviderDialog() {},
    dlgProvider: { close() {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('$("dp-key-reveal").onclick()', sandbox)
  assert.equal(input.type, "text", "a click reveals the typed key")
  assert.equal(button["aria-pressed"], "true")
  assert.equal(button["aria-label"], "Скрыть ключ")
  assert.equal(button.dataset.tip, "Скрыть ключ", "the tip follows the state, not the old label")
  vm.runInContext('$("dp-key-reveal").onclick()', sandbox)
  assert.equal(input.type, "password", "and the next click hides it again")
  // Reopening the dialog must not leave a revealed field behind.
  vm.runInContext("setKeyRevealed(true); setKeyRevealed(false)", sandbox)
  assert.equal(input.type, "password")
})
