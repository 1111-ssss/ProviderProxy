let imageProviderFilter = ""
const imageState = { provider: null, taskId: null, pollTimer: null, referenceImage: "" }

function imageModelIds(provider) {
  // Connections is the single source of truth; cached catalog entries are not selected models.
  return [...new Set(cfg.providers[provider]?.models ?? [])].filter((id) => isImageModel(provider, id)).sort()
}

function imageProviders() {
  return Object.keys(cfg.providers).filter((name) => imageModelIds(name).length)
}

function renderImageGenerator() {
  const allNames = imageProviders()
  const query = imageProviderFilter.trim().toLowerCase()
  const shownNames = query ? allNames.filter((name) => name.toLowerCase().includes(query)) : allNames
  const settings = imageSettings()
  if (!allNames.includes(imageState.provider)) imageState.provider = allNames.includes(settings.defaultProvider) ? settings.defaultProvider : allNames[0] ?? null
  $("ig-provider-options").innerHTML = shownNames.length
    ? shownNames
        .map((name) => `<button type="button" class="provider-option ${name === imageState.provider ? "active" : ""}" data-provider="${esc(name)}" role="option" aria-selected="${name === imageState.provider}"><strong>${esc(name)}</strong></button>`)
        .join("")
    : emptyStateHtml(allNames.length ? "ничего не найдено" : "моделей изображений пока нет — обнови список на вкладке «Подключения» и отметь image-модель")
  $("ig-provider-current").innerHTML = imageState.provider ? `<strong>${esc(imageState.provider)}</strong>` : "<strong>-</strong>"
  const ids = imageState.provider ? imageModelIds(imageState.provider) : []
  const selectedModel = $("ig-model").value
  $("ig-model").innerHTML = ids.length ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("") : `<option value="">нет доступных моделей</option>`
  const preferredModel = ids.includes(selectedModel) ? selectedModel : ids.includes(settings.defaultModel) ? settings.defaultModel : ids[0]
  if (preferredModel) $("ig-model").value = preferredModel
  $("ig-model").disabled = !ids.length
  $("ig-provider-filter").value = imageProviderFilter
  $("ig-provider-options").querySelectorAll("[data-provider]").forEach((button) => {
    button.onclick = () => {
      imageState.provider = button.dataset.provider
      renderImageGenerator()
    }
  })
}

function renderImageSettings() {
  const settings = imageSettings()
  const providers = imageProviders()
  const providerSelect = $("ig-default-provider")
  providerSelect.innerHTML = providers.length ? providers.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("") : `<option value="">нет image-провайдеров</option>`
  if (providers.includes(settings.defaultProvider)) providerSelect.value = settings.defaultProvider
  else if (providers[0]) { settings.defaultProvider = providers[0]; providerSelect.value = providers[0] }
  const renderDefaultModels = () => {
    const ids = providerSelect.value ? imageModelIds(providerSelect.value) : []
    $("ig-default-model").innerHTML = ids.length ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("") : `<option value="">нет image-моделей</option>`
    if (ids.includes(settings.defaultModel)) $("ig-default-model").value = settings.defaultModel
    else if (ids[0]) { settings.defaultModel = ids[0]; $("ig-default-model").value = ids[0] }
  }
  renderDefaultModels()
  providerSelect.onchange = () => { settings.defaultProvider = providerSelect.value; settings.defaultModel = ""; renderDefaultModels(); save(); renderImageGenerator() }
  $("ig-default-model").onchange = (event) => { settings.defaultModel = event.target.value; save(); renderImageGenerator() }
}

function imageResultValue(payload) {
  const read = (value) => {
    if (typeof value === "string" && value) return value
    if (Array.isArray(value)) return value.map(read).find(Boolean) ?? null
    if (!value || typeof value !== "object") return null
    return value.url ?? value.image_url?.url ?? value.image_url ?? value.b64_json ?? value.base64 ?? read(value.result) ?? read(value.data) ?? read(value.output) ?? null
  }
  return read(payload?.result ?? payload?.data ?? payload?.output ?? payload)
}

function imageTaskStatus(payload) {
  return String(payload?.status ?? payload?.result?.status ?? payload?.data?.status ?? "").toLowerCase()
}
function imageErrorMessage(payload, response) {
  const error = payload?.error
  const message = typeof error === "string" ? error : error?.message ?? payload?.detail ?? `HTTP ${response?.status ?? "?"}`
  const endpoint = payload?.endpoint ? ` · ${payload.endpoint}` : ""
  const size = payload?.requestBytes ? ` · ${payload.requestBytes} bytes` : ""
  const suggestions = Array.isArray(payload?.suggestedModels) && payload.suggestedModels.length ? ` · попробуй: ${payload.suggestedModels.join(", ")}` : ""
  return `${message}${endpoint}${size}${suggestions}`
}

function renderImageResult(message = "задача ещё не запущена", value = null) {
  $("ig-task-status").textContent = message
  $("ig-preview").closest(".image-result").classList.toggle("is-error", /^ошибка/i.test(message))
  if (!value) {
    $("ig-preview").innerHTML = `<div class="image-empty">${esc(message === "задача ещё не запущена" ? "Здесь появится готовое изображение." : "Результат ещё не готов.")}</div>`
    return
  }
  const src = /^(https?:|data:|blob:)/i.test(value) ? value : `data:image/png;base64,${value}`
  $("ig-preview").innerHTML = `<img src="${esc(src)}" alt="Сгенерированное изображение"><a href="${esc(src)}" target="_blank" rel="noreferrer">Открыть результат отдельно</a>`
}

function clearImagePolling() {
  if (imageState.pollTimer) clearTimeout(imageState.pollTimer)
  imageState.pollTimer = null
}

async function pollImageTask(provider, taskId) {
  if (imageState.provider !== provider || imageState.taskId !== taskId) return
  try {
    const response = await api(`/api/image-tasks/${encodeURIComponent(provider)}/${encodeURIComponent(taskId)}`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(imageErrorMessage(payload, response))
    const result = imageResultValue(payload)
    const status = imageTaskStatus(payload)
    if (result && (!status || ["completed", "complete", "success", "succeeded", "done"].includes(status))) {
      clearImagePolling()
      renderImageResult("готово", result)
      return
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      clearImagePolling()
      renderImageResult(`ошибка: ${apiErrorMessage(payload, payload.result?.error ?? "задача завершилась неуспешно")}`)
      return
    }
    renderImageResult(`статус: ${status || "обрабатывается"} · следующая проверка через 3,5 с`)
    imageState.pollTimer = setTimeout(() => pollImageTask(provider, taskId), 3500)
  } catch (error) {
    clearImagePolling()
    renderImageResult(`ошибка проверки: ${error.message}`)
    flash(false, `Генерация изображения: ${error.message}`)
  }
}

$("ig-provider-filter").oninput = (e) => {
  imageProviderFilter = e.target.value
  renderImageGenerator()
  const input = $("ig-provider-filter")
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}
$("ig-provider-filter-clear").onclick = () => {
  imageProviderFilter = ""
  $("ig-provider-filter").value = ""
  renderImageGenerator()
  $("ig-provider-filter").focus()
}
$("ig-image-file").onchange = () => {
  const file = $("ig-image-file").files?.[0]
  imageState.referenceImage = ""
  $("ig-image-file-name").textContent = ""
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    imageState.referenceImage = String(reader.result ?? "")
    $("ig-image-file-name").textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} КБ`
  }
  reader.readAsDataURL(file)
}
$("ig-form").onsubmit = async (event) => {
  event.preventDefault()
  const provider = imageState.provider
  const model = $("ig-model").value
  const prompt = $("ig-prompt").value.trim()
  if (!provider || !model) return flash(false, "сначала выбери провайдера и image-модель")
  if (!prompt) return flash(false, "впиши промпт")
  clearImagePolling()
  imageState.taskId = null
  renderImageResult(`отправляю в ${imageModelEndpoint(provider, model)}…`)
  const referenceImage = $("ig-image").value.trim() || imageState.referenceImage
  const body = { provider, model, prompt, ratio: $("ig-ratio").value, size: $("ig-size").value.trim(), image: referenceImage }
  for (const key of ["size", "image"]) if (!body[key]) delete body[key]
  try {
    const response = await api("/api/image-tasks", { method: "POST", body: JSON.stringify(body) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(imageErrorMessage(payload, response))
    const taskId = payload.task_id ?? payload.taskId ?? payload.id ?? payload.data?.task_id ?? payload.data?.taskId ?? payload.data?.id
    const immediate = imageResultValue(payload)
    if (immediate && !taskId) return renderImageResult("готово", immediate)
    if (!taskId) throw new Error("провайдер не вернул task_id")
    imageState.taskId = String(taskId)
    renderImageResult(`задача ${imageState.taskId} создана · ожидаю результат`)
    imageState.pollTimer = setTimeout(() => pollImageTask(provider, imageState.taskId), 1000)
  } catch (error) {
    renderImageResult(`ошибка создания: ${error.message}`)
    flash(false, `Генерация изображения: ${error.message}`)
  }
}
$("ig-clear").onclick = () => {
  clearImagePolling()
  imageState.taskId = null
  imageState.referenceImage = ""
  $("ig-image-file").value = ""
  $("ig-image-file-name").textContent = ""
  renderImageResult()
}
