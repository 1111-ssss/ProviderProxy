const TABS = ["providers", "connections", "integrations", "chains", "models", "images", "logs", "usage", "settings"]
let tab = localStorage.getItem("pp_tab") ?? "providers"

const navigation = document.querySelector("main")
const navigationCollapseButton = $("tabs-collapse")
const navigationCollapsed = localStorage.getItem("pp_navigation_collapsed") === "1"
function setNavigationCollapsed(collapsed) {
  navigation.classList.toggle("nav-collapsed", collapsed)
  navigationCollapseButton.setAttribute("aria-expanded", String(!collapsed))
  navigationCollapseButton.setAttribute("aria-label", collapsed ? "Развернуть навигацию" : "Свернуть навигацию")
  navigationCollapseButton.title = collapsed ? "Развернуть навигацию" : "Свернуть навигацию"
  localStorage.setItem("pp_navigation_collapsed", collapsed ? "1" : "0")
}
setNavigationCollapsed(navigationCollapsed)
navigationCollapseButton.onclick = () => setNavigationCollapsed(!navigation.classList.contains("nav-collapsed"))

let collapsedGroups = {}
try { collapsedGroups = JSON.parse(localStorage.getItem("pp_collapsed_groups") ?? "{}") || {} } catch { collapsedGroups = {} }
function setGroupCollapsed(group, collapsed) {
  const button = document.querySelector(`.tab-group-toggle[data-group="${group}"]`)
  const node = button?.closest(".tab-group")
  if (!button || !node) return
  node.classList.toggle("is-collapsed", collapsed)
  button.setAttribute("aria-expanded", String(!collapsed))
  collapsedGroups[group] = collapsed
  localStorage.setItem("pp_collapsed_groups", JSON.stringify(collapsedGroups))
}
document.querySelectorAll(".tab-group-toggle").forEach((button) => {
  const group = button.dataset.group
  setGroupCollapsed(group, Boolean(collapsedGroups[group]))
  button.onclick = () => setGroupCollapsed(group, !button.closest(".tab-group").classList.contains("is-collapsed"))
})

function showTab(name) {
  if (!TABS.includes(name)) name = "providers"
  tab = name
  debugLog("tab", { name })
  localStorage.setItem("pp_tab", name)
  document.querySelectorAll(".tabs button").forEach((b) => {
    const isActive = b.dataset.tab === name
    b.classList.toggle("active", isActive)
  })
  const activeGroup = document.querySelector(`.tabs button[data-tab="${name}"]`)?.closest(".tab-group")
  if (activeGroup?.classList.contains("is-collapsed")) setGroupCollapsed(activeGroup.querySelector(".tab-group-toggle")?.dataset.group, false)
  document.querySelectorAll(".tab-group").forEach((group) => {
    group.classList.toggle("is-active", Boolean(group.querySelector("button.active")))
  })
  document.querySelectorAll("main > section[data-tab]").forEach((s) => (s.style.display = s.dataset.tab === name ? "" : "none"))
  if (name === "settings") renderSettings()
  if (name === "integrations") loadImageSkillStatus()
  if (name === "logs") loadLogs()
  if (name === "usage") loadUsage()
}
document.querySelectorAll(".tabs button[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)))

// Digits switch tabs while nothing else claims the keyboard: no focused input
// and no open dialog. 1..8 pick tabs in order, 0 opens the last one (settings);
// 9 has no tab and is ignored.
const TAB_KEYS = { "1": "providers", "2": "connections", "3": "integrations", "4": "chains", "5": "models", "6": "images", "7": "logs", "8": "usage", "0": "settings" }
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.altKey || event.metaKey) return
  const target = event.target
  if (target instanceof Element) {
    const tag = target.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return
  }
  if (document.querySelector("dialog[open]")) return
  const name = TAB_KEYS[event.key]
  if (!name) return
  event.preventDefault()
  showTab(name)
})

