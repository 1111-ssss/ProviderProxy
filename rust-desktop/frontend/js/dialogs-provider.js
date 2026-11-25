const dlgProvider = $("dlg-provider")
let editingProvider = null
// The script's source never goes into a form field: the dialog picks a file and
// keeps its text in this draft, so a cancel leaves the stored script untouched.
let uptimeDraft = { script: "", file: "" }
// A pasted endpoint often ends with "/v1/" or a stray slash; the proxy builds
// ".../chat/completions" from this value, so keep it without a trailing slash.
const normalizeBaseUrl = (url) => url.replace(/\/+$/, "")

function renderUptimeFile() {
  const name = $("dp-uptime-name")
  if (uptimeDraft.file) {
    name.textContent = uptimeDraft.file
    name.classList.remove("muted")
  } else {
    name.textContent = uptimeDraft.script ? "скрипт в конфиге" : "файл не выбран"
    name.classList.toggle("muted", !uptimeDraft.script)
  }
  $("dp-uptime-clear").hidden = !uptimeDraft.file && !uptimeDraft.script
}

function openProviderDialog(name = null) {
  editingProvider = name
  dlgProvider.returnValue = ""
  $("dp-title").textContent = name ? `Провайдер «${name}»` : "Добавить провайдера"
  $("dp-name").value = name ?? ""
  $("dp-url").value = name ? cfg.providers[name]?.baseURL ?? "" : ""
  $("dp-key").value = ""
  setKeyRevealed(false)
  $("dp-key").placeholder = name && cfg.providers[name]?.apiKeyConfigured ? "оставить текущий ключ" : "sk-..."
  $("dp-checkin").value = name ? cfg.providers[name]?.checkin ?? "" : ""
  $("dp-homepage").value = name ? cfg.providers[name]?.homepage ?? "" : ""
  const rec = name ? cfg.providers[name] : null
  uptimeDraft = { script: rec?.uptimeScript ?? "", file: rec?.uptimeScriptFile ?? "" }
  $("dp-uptime-file").value = ""
  renderUptimeFile()
  // A provider with an optional field set is the case the section exists for;
  // folding it away would hide the value the user came to check.
  $("dp-more").open = Boolean(rec?.checkin || rec?.homepage || uptimeDraft.script)
  $("dp-delete").hidden = !name
  dlgProvider.showModal()
}

// The eye toggles the field only; the value is never re-read from here, so a
// revealed key cannot leak into the saved config by accident.
function setKeyRevealed(revealed) {
  const button = $("dp-key-reveal")
  $("dp-key").type = revealed ? "text" : "password"
  button.setAttribute("aria-pressed", String(revealed))
  button.setAttribute("aria-label", revealed ? "Скрыть ключ" : "Показать ключ")
  button.dataset.tip = revealed ? "Скрыть ключ" : "Показать ключ"
}
$("dp-key-reveal").onclick = () => setKeyRevealed($("dp-key").type === "password")
$("p-add").onclick = () => openProviderDialog()
$("dp-cancel").onclick = () => dlgProvider.close()
$("dp-uptime-file").onchange = async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    uptimeDraft = { script: await file.text(), file: file.name }
    renderUptimeFile()
  } catch (error) {
    flash(false, `не удалось прочитать файл: ${error.message ?? error}`)
  }
}
$("dp-uptime-clear").onclick = () => {
  uptimeDraft = { script: "", file: "" }
  $("dp-uptime-file").value = ""
  renderUptimeFile()
}
$("dp-delete").onclick = async () => {
  const name = editingProvider
  if (!name || !(await deleteProvider(name))) return
  dlgProvider.close()
}

$("dp-form").addEventListener("submit", (e) => {
  const name = $("dp-name").value.trim()
  if (cfg.providers[name] && name !== editingProvider) {
    e.preventDefault()
    flash(false, "имя провайдера занято")
  }
})
dlgProvider.addEventListener("close", () => {
  if (dlgProvider.returnValue !== "save") return
  const name = $("dp-name").value.trim()
  // keep fields the dialog does not edit (models allowlist, headers) when renaming/editing
  const rec = { ...(editingProvider ? cfg.providers[editingProvider] : {}), baseURL: normalizeBaseUrl($("dp-url").value.trim()), apiKey: $("dp-key").value.trim() }
  if (editingProvider && !rec.apiKey && cfg.providers[editingProvider]?.apiKeyConfigured) rec.apiKeySource = editingProvider
  const checkin = $("dp-checkin").value.trim()
  if (checkin) rec.checkin = checkin
  else delete rec.checkin
  const homepage = $("dp-homepage").value.trim()
  if (homepage) rec.homepage = homepage
  else delete rec.homepage
  // The text is what the runner executes; the file name is only a label, so a
  // renamed or moved file still leaves a working script.
  if (uptimeDraft.script.trim()) rec.uptimeScript = uptimeDraft.script
  else delete rec.uptimeScript
  if (uptimeDraft.file) rec.uptimeScriptFile = uptimeDraft.file
  else delete rec.uptimeScriptFile
  cfg.providers[name] = rec
  if (editingProvider && editingProvider !== name) {
    delete cfg.providers[editingProvider]
    if (cfg.opencodeModels?.[editingProvider]) {
      cfg.opencodeModels[name] = cfg.opencodeModels[editingProvider]
      delete cfg.opencodeModels[editingProvider]
    }
    for (const m of Object.values(cfg.models))
      for (const u of m.upstreams ?? []) if (u.provider === editingProvider) u.provider = name
  }
  save(); renderAll()
})
