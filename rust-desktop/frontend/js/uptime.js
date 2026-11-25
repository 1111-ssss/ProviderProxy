// Uptime dialog: the provider's own script decides what "uptime" means, the
// dialog only draws the bars it returns. Same bar markup as the statistics
// chart, so a percentage looks identical everywhere.

const dlgUptime = $("dlg-uptime")
let uptimeProvider = null

function openUptimeDialog(provider) {
  uptimeProvider = provider
  dlgUptime.returnValue = ""
  $("uptime-title").textContent = `Аптайм · ${provider}`
  $("uptime-body").innerHTML = `<div class="empty-inline">запускаю скрипт…</div>`
  $("uptime-meta").textContent = ""
  dlgUptime.showModal()
  loadUptime()
}

async function loadUptime() {
  if (!uptimeProvider) return
  const provider = uptimeProvider
  const body = $("uptime-body")
  body.innerHTML = `<div class="empty-inline">запускаю скрипт…</div>`
  const r = await api("/api/uptime/run", { method: "POST", body: JSON.stringify({ provider }) })
  if (uptimeProvider !== provider) return // dialog switched or closed meanwhile
  const payload = await r.json().catch(() => ({}))
  if (!r.ok) {
    body.innerHTML = `<div class="empty-inline is-error">${esc(apiErrorMessage(payload, `HTTP ${r.status}`))}</div>`
    return
  }
  const bars = payload.bars ?? []
  $("uptime-meta").textContent = `${plural(bars.length, "модель", "модели", "моделей")} · обновлено ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
  body.innerHTML = bars.length
    ? bars
        .map((bar) => {
          const percent = Math.max(0, Math.min(100, Number(bar.percent) || 0))
          const kind = percent >= 99 ? "success" : percent >= 90 ? "limit" : "error"
          return `<div class="token-row">
            <div class="token-row-head"><span data-tip="${esc(bar.label)}">${esc(bar.label)}</span><span class="problem-rate"><b>${percent.toFixed(1)}%</b></span></div>
            <div class="token-track"><span class="token-fill ${kind}" style="width:${percent}%"></span></div>
          </div>`
        })
        .join("")
    : `<div class="empty-inline">скрипт не вернул ни одной полосы</div>`
}

$("uptime-refresh").onclick = () => loadUptime()
$("uptime-close").onclick = () => dlgUptime.close()
dlgUptime.addEventListener("close", () => {
  uptimeProvider = null
})

// --- Uptime tab -------------------------------------------------------------
// Two views exist so the section has its final shape; both are placeholders
// until there is real data to draw.

function renderUptimeTab() {
  for (const panel of document.querySelectorAll(".uptime-panel")) {
    panel.innerHTML = emptyStateHtml("в разработке")
  }
}

function showUptimeGroup(group) {
  for (const button of $("uptime-groups").querySelectorAll("[data-uptime-group]")) {
    const active = button.dataset.uptimeGroup === group
    button.classList.toggle("active", active)
    button.setAttribute("aria-selected", String(active))
  }
  for (const panel of document.querySelectorAll(".uptime-panel")) {
    panel.classList.toggle("active", panel.dataset.uptimePanel === group)
  }
}

$("uptime-groups").querySelectorAll("[data-uptime-group]").forEach((button) => {
  button.onclick = () => showUptimeGroup(button.dataset.uptimeGroup)
})
renderUptimeTab()
