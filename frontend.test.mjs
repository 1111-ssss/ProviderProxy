// Dependency-free regression checks for the shared image UI in both frontends.
// Run: node --test frontend.test.mjs
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { test } from "node:test"
import vm from "node:vm"

for (const file of ["public/index.html", "rust-desktop/frontend/index.html"]) {
  const html = readFileSync(new URL(file, import.meta.url), "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", querySelectorAll: () => [] })
    return elements.get(id)
  }
  const context = vm.createContext({ $: element, save: () => {}, esc: (s) => String(s ?? "") })
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
  run(script.slice(script.indexOf("const modelDetails ="), script.indexOf("async function api(")))
  run(script.slice(script.indexOf('let imageProviderFilter = ""'), script.indexOf("function imageResultValue(")))
  run(script.slice(script.indexOf("function removeModelFromChains"), script.indexOf("function removeImageModelsFromChains")))

  test(`${file}: script parses and the redundant model permission UI is gone`, () => {
    new vm.Script(script)
    assert.ok(!html.includes('id="ig-skill-models"'))
    assert.ok(!html.includes("data-skill-provider"))
    assert.ok(!html.includes("▧"))
    assert.ok(html.includes('id="ig-default-provider"') && html.includes('id="ig-default-model"'))
    assert.match(html, /class="image-field-heading">Размер/)
    assert.match(html, /\.image-form \.row \{ align-items: end; \}/)
    assert.ok(html.includes('id="u-days"'), "usage should expose the seven-day selector")
    assert.ok(html.includes("сохранено между сессиями"), "usage should explain persisted history")
    assert.ok(html.includes('data-tab="settings"'), "settings should be a navigation tab")
    assert.ok(html.includes('id="tabs-collapse"'), "navigation should be collapsible")
    assert.ok(html.includes('class="tab-group-toggle"'), "navigation groups should be collapsible")
    assert.ok(!html.includes('class="tab-group-chevron" aria-hidden="true">⌄'), "group arrows should not use a font glyph")
    assert.match(html, /\.tab-group-chevron \{[\s\S]*transform-origin: 50% 50%/, "group arrows should rotate around their center")
    assert.match(html, /main > section \{ grid-row: 1; height: 100%; min-height: 0; overflow: auto; \}/, "work cards should own the desktop scrollbar")
    assert.match(html, /\.tabs \{ grid-row: 1; height: 100%; max-height: none;/, "navigation should fill the desktop viewport")
    assert.ok(html.includes("main.nav-collapsed .tabs { align-self: start; height: fit-content; max-height: none; overflow: visible; }"), "collapsed navigation should shrink to the arrow card")
    assert.ok(html.includes('id="s-base-url"'), "proxy base URL should live in the settings page")
    assert.ok(html.includes('id="s-check-update"'), "desktop settings should expose a manual update check")
    assert.ok(html.includes('id="s-version"'), "settings should show the application version")
    assert.ok(html.includes("const lines = (j.lines ?? []).slice().reverse()"), "logs should show newest entries first")
    assert.ok(html.includes("const atTop = box.scrollTop <= 60"), "log refresh should preserve the newest entries at the top")
    assert.equal(run("formatContext(1000000)"), "1m")
    assert.equal(run("formatContext(1500000)"), "1.5m")
    assert.equal(run("contextLabel({ contextLength: 50000, contextLengthManual: true, providerContextLength: 1000000 })"), "50k / 1m")
    assert.equal(run("contextValues({ contextLength: 2000000, contextLengthManual: true, providerContextLength: 1000000 }).current"), 1000000)
    run('cfg.providers.selected.modelInfo.chat = { contextLength: 500000 }')
    assert.equal(run('modelContextSuffix("selected", "chat")'), '<span class="model-context">(ctx 500k)</span>')
    assert.equal(run('modelContextSuffix("selected", "missing")'), "")
    run('cfg.providers.selected.models = ["chat", "new-model"]; cfg.opencodeModels = { selected: { all: true, models: ["chat"] } }')
    assert.deepEqual(JSON.parse(run('JSON.stringify(directModelIds("selected"))')), ["chat", "new-model"])
    run('cfg.providers.selected.models = ["endpoint-only", "chosen-image", "chat", "chosen-image"]; delete cfg.opencodeModels')
    assert.match(html, /section\[data-tab="logs"\] \{ height: calc\(/, "logs should fill the workspace")
    assert.match(html, /\.logbox \{ flex: 1 1 auto; min-height: 0;/, "logs should scroll inside their section")
    assert.ok(!html.includes(".settings-page { min-height: calc(100vh"), "pages should not have an artificial viewport height")
    assert.ok(html.includes('id="config-export"') && html.includes('id="config-import"'), "settings should expose config import/export")
    assert.ok(html.includes('id="config-export-keys"') && html.includes('id="config-export-chains"') && html.includes('id="config-export-models"'), "config export sections should be optional")
    assert.ok(html.includes('checked ? "true" : "false"'), "Rust export query booleans should use true/false")
    assert.ok(html.includes('tauriInvoke("restart_app")') && html.includes("window.location.reload()"), "config import should restart after success")
    assert.ok(!html.includes('id="settings-open"'), "duplicate header settings button should be gone")
    assert.match(html, /class="settings-nav-button" data-tab="settings"/)
    assert.ok(!html.includes('data-group="settings"'), "settings should be outside collapsible groups")
    assert.ok(!html.includes('<h1>Provider Proxy</h1>'), "redundant page title should be removed")
    const integrationStart = html.indexOf('<div class="opencode-panel integration-card">')
    const chainsStart = html.indexOf('<section data-tab="chains">', integrationStart)
    const integrationPanel = integrationStart >= 0 && chainsStart > integrationStart ? html.slice(integrationStart, chainsStart) : ""
    assert.ok(integrationPanel?.includes('class="skill-card integration-skill-card"'), "image skill should live inside the OpenCode panel")
    assert.ok(html.includes("В подключённой интеграции они будут доступны как"), "model copy should stay integration-neutral")
    assert.ok(!html.includes("В OpenCode") && !html.includes("в OpenCode"), "user-facing model copy should not name a concrete integration")
    assert.ok(!html.includes("(config)"), "model labels should not expose an integration-specific suffix")
    assert.ok(html.includes("definition?.all === true") && html.includes("directModelIds"), "select-all direct models should follow provider model updates")
    assert.ok(!html.includes("Каждая модель будет записана как"), "direct model dialog should not repeat the provider/model format")
    assert.ok(!html.includes('content: \"⌕\"'), "search fields should not use the broken text magnifier")
    assert.ok(html.includes('<span class="opencode-model"><strong>${esc(id)}</strong>${modelContextSuffix(provider, id)}</span>'), "direct model pills should show model context when known")
    assert.ok(html.includes('return context ? `<span class="model-context">(ctx ${esc(context)})</span>` : ""'), "unknown model context should not render a suffix")
    assert.ok(html.includes('class="opencode-model chain-model"'), "chain models should use the model pills")
    assert.ok(html.includes("${chainContextBadge(ups)}") && !html.includes("contextBadge(u.provider, u.model)"), "chain context should be shown once on the chain")
    assert.ok(html.includes(".chain-toggle { position: relative") && html.includes("min-height: 38px"), "status toggles should match action button height")
    assert.ok(html.includes('class="chain-toggle-text">${enabled ? "Активен" : "Скрыт"}</span>'), "direct model status should use compact labels")
    assert.ok(html.includes('class="chain-toggle-text">${enabled ? "Активна" : "Скрыта"}</span>'), "chain status should use compact labels")
    assert.ok(!html.includes("провайдер активен"), "direct model status should not have a provider subtitle")
    assert.ok(html.includes(".direct-model-card .chain-toggle { width: 134px;") && html.includes("#models .chain-toggle { width: 134px;"), "model and chain status buttons should have the same width")
    // Layout regressions: a settings card must never be able to push its
    // controls or neighbour cards outside the column.
    assert.match(html, /\.settings-grid label \{ margin: 0; min-width: 0; \}/, "settings labels should shrink with their column")
    assert.ok(html.includes('input:not([type="checkbox"])'), "only text fields should stretch; a stretched checkbox squeezed its label to zero width")
    assert.match(html, /\.settings-grid \.setting-option span \{ display: grid; gap: 2px; flex: 1 1 auto; min-width: 0; grid-template-columns: minmax\(0, 1fr\); \}/, "option text needs a shrinkable single-column track")
    assert.match(html, /\.settings-grid \.setting-action \{ display: flex;[\s\S]*?flex-wrap: wrap; \}/, "long shortcut paths should drop the button under the text")
    assert.ok(html.includes(".token-row-head span:first-child { color: #d8e4f1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }"), "provider names should ellipsize instead of overflowing")
    assert.ok(html.includes("min-height: 100dvh"), "the shell should follow the visible viewport on mobile browsers")
    assert.ok(html.includes("@container (max-width: 420px)"), "the outcome legend should stack instead of being squeezed")
  })

  test(`${file}: only selected Connections image models are available`, () => {
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

  test(`${file}: removing connection models cleans chains and direct models`, () => {
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
}
