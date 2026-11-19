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

test("the concatenated scripts parse", () => {
  new vm.Script(scripts)
})

// A minimal DOM so the pure helpers can run without a browser.
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

test("a chat log line shows the full session id and the chain under the date", () => {
  // logCard builds DOM nodes; give it a tiny node/document stub of its own.
  const node = (tag) => ({ tagName: tag, className: "", textContent: "", title: "", dataset: {}, children: [], append(...kids) { this.children.push(...kids) } })
  const ctx = vm.createContext({ document: { createElement: (tag) => node(tag) } })
  vm.runInContext(scripts.slice(scripts.indexOf("const logCard = ("), scripts.indexOf("const logEmpty =")), ctx)
  const line = "[2026-11-15 10:04:35] logfare-1mil → ответ: logfare/deepseek-v4.1-flash-1017 (HTTP 200 OK) [ses:ses_e21fa60f0ffeD7GJwkbN2F0UGs]"
  const card = vm.runInContext(`logCard(${JSON.stringify(line)})`, ctx)
  // The header holds the date and the session chip; the chip keeps the whole id.
  const top = card.children[0]
  assert.equal(top.className, "t")
  const ses = top.children.find((c) => c.className === "ses")
  assert.ok(ses, "the session chip is present")
  assert.equal(ses.textContent, "ses_e21fa60f0ffeD7GJwkbN2F0UGs", "the id is not shortened")
  assert.equal(ses.dataset.sessionCopy, "ses_e21fa60f0ffeD7GJwkbN2F0UGs", "clicking copies the full id")
  // The chain name sits on its own line right under the header, not inside it.
  const chain = card.children.find((c) => c.className === "chain")
  assert.ok(chain, "the chain name has its own line")
  assert.equal(chain.textContent, "logfare-1mil")
  assert.ok(!top.children.some((c) => c.className === "chain"), "the chain is not in the header row")
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
