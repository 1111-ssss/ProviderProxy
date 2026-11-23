const dlgProvider = $("dlg-provider")
let editingProvider = null
// A pasted endpoint often ends with "/v1/" or a stray slash; the proxy builds
// ".../chat/completions" from this value, so keep it without a trailing slash.
const normalizeBaseUrl = (url) => url.replace(/\/+$/, "")

function openProviderDialog(name = null) {
  editingProvider = name
  dlgProvider.returnValue = ""
  $("dp-title").textContent = name ? `Провайдер «${name}»` : "Добавить провайдера"
  $("dp-name").value = name ?? ""
  $("dp-url").value = name ? cfg.providers[name]?.baseURL ?? "" : ""
  $("dp-key").value = ""
  $("dp-key").placeholder = name && cfg.providers[name]?.apiKeyConfigured ? "оставить текущий ключ" : "sk-..."
  $("dp-checkin").value = name ? cfg.providers[name]?.checkin ?? "" : ""
  $("dp-homepage").value = name ? cfg.providers[name]?.homepage ?? "" : ""
  $("dp-delete").hidden = !name
  dlgProvider.showModal()
}

$("p-add").onclick = () => openProviderDialog()
$("dp-cancel").onclick = () => dlgProvider.close()
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

