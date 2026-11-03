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
    assert.ok(html.includes("const lines = (j.lines ?? []).slice().reverse()"), "logs should show newest entries first")
    assert.ok(html.includes("const atTop = box.scrollTop <= 60"), "log refresh should preserve the newest entries at the top")
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
