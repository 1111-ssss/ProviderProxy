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
}
