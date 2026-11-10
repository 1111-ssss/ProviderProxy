// Smoke test: 429 failover, cooldown skip, model/key mapping, catalog, unknown model,
// GUI page, provider model list, config hot-reload via PUT /api/config.
// Run: node test.mjs   (mock upstreams + proxy on ports 48787-48789)
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const here = dirname(fileURLToPath(import.meta.url))
const PROXY = 48787,
  A = 48788,
  B = 48789
const base = (p) => `http://127.0.0.1:${p}`
const dayKey = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

let aHits = 0
const upstreamA = createServer((_req, res) => {
  let raw = ""
  _req.on("data", (c) => (raw += c))
  _req.on("end", () => {
    aHits++
    // A "не умеет" картинки: такой запрос отвечает 400 unsupported (как hyperfusion на image_url)
    if (raw.includes("image_url")) {
      res.writeHead(400, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: 'content[0].type has unsupported value "image_url"' } }))
    }
    res.writeHead(429, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "insufficient_quota" } }))
  })
})
const upstreamB = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/images/tasks/task-1") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ status: "completed", result: { url: "https://example.test/generated.png" } }))
  }
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ data: [{ id: "model-b", context_length: 131072 }, { id: "model-b2", context_length: 32768, type: "image", endpoints: ["images/tasks"] }, { id: "model-b3", type: "model", endpoints: ["images/generations"] }] }))
  }
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ url: "https://example.test/generated-sync.png" }], received: body }))
    })
    return
  }
  if (req.method === "POST" && req.url === "/v1/images/tasks") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      if (body.model === "model-error") {
        res.writeHead(503, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "image upstream unavailable" } }))
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ task_id: "task-1", received: body, status: "pending" }))
    })
    return
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      if (body.messages?.some((message) => message?.tool_calls?.some((call) => typeof call?.function?.arguments !== "string"))) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "Invalid JSON body: tool call arguments must be a string" } }))
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" })
        res.write(": keepalive\r\n\r\n")
        res.write("event: message\r\ndata: null\r\n\r\n")
        if (body.messages?.[0]?.content === "no-finish") return res.end("data: {\"id\":\"chatcmpl-test\",\"choices\":[]}\n\ndata: [DONE]\r\n\r\n")
        if (body.messages?.[0]?.content === "broken-stream") {
          res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ delta: { content: "partial" } }] })}\n\n`)
          return setTimeout(() => res.destroy(), 10)
        }
        res.write(`event: message\n\ndata: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: "{}" } }] } }], usage: null })}\n\n`)
        return res.end("data: [DONE]\r\n\r\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, model: body.model, auth: req.headers.authorization, usage: { prompt_tokens: 11, completion_tokens: 22 } }))
    })
    return
  }
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    const body = JSON.parse(raw)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, model: body.model, auth: req.headers.authorization, usage: { prompt_tokens: 11, completion_tokens: 22 } }))
  })
})

const cfgDir = mkdtempSync(join(tmpdir(), "provider-proxy-test-"))
const cfg = join(cfgDir, "config.json")
const keyFile = join(cfgDir, "master.key")
const statsFile = join(cfgDir, "usage-stats.json")
const skillHome = join(cfgDir, "home")
mkdirSync(skillHome)
const skillDir = join(skillHome, ".config", "opencode", "skills")
writeFileSync(statsFile, JSON.stringify({ version: 1, retentionDays: 7, days: { [dayKey(-1)]: { requests: 3, ok: 2, failed: 1, providers: {}, models: {}, images: {} }, [dayKey(-8)]: { requests: 99 } } }))
// opencode-конфиг теста — отдельный файл, чтобы синхронизация не трогала настоящий ~/.config/opencode
const ocCfg = join(cfgDir, "opencode.json")
writeFileSync(
  ocCfg,
  JSON.stringify({
    providers: {
      "provider-proxy": { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "http://127.0.0.1:1/v1" } },
      other: { name: "Other" },
    },
  }),
)
const ocInode = statSync(ocCfg).ino
writeFileSync(
  cfg,
  JSON.stringify({
    port: PROXY,
    limitCooldownSec: 60,
    errorCooldownSec: 5,
    opencodeConfig: ocCfg,
    models: {
      test: {
        upstreams: [
          { name: "A", baseURL: `${base(A)}/v1`, apiKey: "key-a", model: "model-a" },
          { name: "B", baseURL: `${base(B)}/v1`, apiKey: "key-b", model: "model-b" },
        ],
      },
      // для 2b: у "img" свой ключ кулдауна, A на нём не охлаждён после шага 1
      img: {
        upstreams: [
          { name: "A", baseURL: `${base(A)}/v1`, apiKey: "key-a", model: "model-a" },
          { name: "B", baseURL: `${base(B)}/v1`, apiKey: "key-b", model: "model-b" },
        ],
      },
    },
  }),
)

const child = spawn(process.execPath, [join(here, "server.mjs"), cfg], {
  env: { ...process.env, HOME: skillHome, PP_CONFIG_KEY_FILE: keyFile, PP_STATS_FILE: statsFile },
  stdio: ["ignore", "pipe", "pipe"],
})
let restartedChild = null
const stopChild = async (process) => {
  if (!process || process.exitCode !== null) return
  process.kill()
  await Promise.race([once(process, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))])
}
let childOut = ""
child.stdout.on("data", (d) => (childOut += d))
child.stderr.on("data", (d) => (childOut += d))

async function up() {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fetch(`${base(PROXY)}/v1/models`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error("proxy did not start:\n" + childOut)
}

const post = (model) =>
  fetch(`${base(PROXY)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  })
const postStream = (model, content = "hi") =>
  fetch(`${base(PROXY)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content }] }),
  })

try {
  await Promise.all([once(upstreamA.listen(A), "listening"), once(upstreamB.listen(B), "listening")])
  await up()

  // 1. A answers 429 -> proxy fails over to B, with B's model id and B's key.
  const r1 = await post("test")
  assert.equal(r1.status, 200)
  const b1 = await r1.json()
  assert.equal(b1.ok, true)
  assert.equal(b1.model, "model-b")
  assert.equal(b1.auth, "Bearer key-b")
  assert.equal(aHits, 1)

  // Upstream may add event/comment frames and null keepalives. The proxy must
  // normalize them to strict OpenAI-compatible data JSON events for OpenCode.
  const stream = await postStream("test")
  assert.equal(stream.status, 200)
  const streamText = await stream.text()
  assert.match(streamText, /data: \{"id":"chatcmpl-test"/)
  assert.match(streamText, /data: \[DONE\]/)
  assert.match(streamText, /"finish_reason":"(?:stop|tool_calls)"/, "proxy should provide a terminal finish_reason")
  assert.match(streamText, /"tool_calls":\[\{"id":"call_1","function":\{"arguments":"\{\}"\},"index":0,"type":"function"\}\]/)
  assert.ok(!streamText.includes('"usage":null'), "null usage must not reach OpenCode")
  assert.ok(!streamText.includes("data: null"), "null SSE keepalives must not reach OpenCode")
  assert.ok(!streamText.includes("event: message"), "custom SSE event fields must not reach OpenCode")

  const incompleteStream = await postStream("test", "no-finish")
  const incompleteText = await incompleteStream.text()
  assert.match(incompleteText, /"finish_reason":"stop"/, "proxy should close an SSE stream without choices")
  assert.match(incompleteText, /data: \[DONE\]/)

  const brokenStream = await postStream("test", "broken-stream")
  const brokenText = await brokenStream.text()
  assert.match(brokenText, /proxy_stream_error/, "upstream stream errors must reach the client")
  const brokenLogs = await (await fetch(`${base(PROXY)}/api/logs`)).json()
  assert.ok(brokenLogs.lines.some((line) => line.includes("ошибка потока") && line.includes("unexpectedly")))

  // 2. A is cooling down -> skipped without a round-trip.
  const r2 = await post("test")
  assert.equal(r2.status, 200)
  assert.equal((await r2.json()).ok, true)
  assert.equal(aHits, 1)

  // Gateways commonly require tool-call arguments to be a JSON string. The
  // client can send a parsed object after a previous tool result; normalize it
  // before forwarding so the request is accepted by strict upstreams.
  const toolRequest = await fetch(`${base(PROXY)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "test",
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: { command: "pwd" } } }] },
        { role: "tool", tool_call_id: "call_1", content: { exitCode: 0, stdout: "/tmp" } },
      ],
    }),
  })
  assert.equal(toolRequest.status, 200)
  assert.equal((await toolRequest.json()).model, "model-b")

  // 2b. 400 "unsupported content" (провайдер не умеет картинки) — запрос не сломан, он не по адресу:
  // прокси свитчится на следующий апстрим, как при 429, а не отдаёт ошибку.
  const ri = await fetch(`${base(PROXY)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "img",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }],
    }),
  })
  assert.equal(ri.status, 200)
  assert.equal((await ri.json()).model, "model-b")

  // 3. Catalog and unknown models.
  const models = await (await fetch(`${base(PROXY)}/v1/models`)).json()
  assert.deepEqual(
    models.data.map((m) => m.id),
    ["test", "img"],
  )
  assert.equal((await post("nope")).status, 404)

  // 4. GUI page is served.
  assert.equal((await fetch(`${base(PROXY)}/`)).status, 200)

  // 5. GUI: fetch a provider's model list through the proxy.
  const r5 = await fetch(`${base(PROXY)}/api/provider-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseURL: `${base(B)}/v1`, apiKey: "key-b" }),
  })
  const providerModels = await r5.json()
  assert.deepEqual(providerModels.models, ["model-b", "model-b2", "model-b3"])
  assert.equal(providerModels.details["model-b"].contextLength, 131072)
  assert.equal(providerModels.details["model-b2"].contextLength, 32768)
  assert.equal(providerModels.details["model-b2"].type, "image")
  assert.equal(providerModels.details["model-b2"].image, true)
  assert.deepEqual(providerModels.details["model-b2"].endpoints, ["images/tasks"])
  assert.deepEqual(providerModels.details["model-b3"].endpoints, ["images/generations"])
  assert.equal(providerModels.details["model-b3"].image, true)

  // 6. GUI: PUT /api/config hot-reloads chains (provider refs, new format).
  const r6 = await fetch(`${base(PROXY)}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      port: PROXY,
      opencodeConfig: ocCfg,
      providers: {
        B: {
          baseURL: `${base(B)}/v1`,
          apiKey: "key-b",
          models: ["model-b2", "model-b3"],
          modelInfo: { "model-b2": { type: "image", endpoints: ["images/tasks"], contextLength: 32768 }, "model-b3": { endpoints: ["images/generations"] }, "model-error": { endpoints: ["images/tasks"] }, "cached-image": { type: "image" } },
        },
      },
      models: {
        fresh: {
          upstreams: [
            { provider: "B", model: "model-b2" },
            { provider: "B", model: "model-b" },
          ],
        },
        paused: {
          enabled: false,
          upstreams: [{ provider: "B", model: "model-b" }],
        },
      },
      opencodeModels: {
        B: { models: ["model-b2"] },
      },
      imageSettings: { skillModels: { B: ["cached-image"] } }, // obsolete allowlist must not override Connections
    }),
  })
  assert.equal(r6.status, 200)
  const r7 = await post("fresh")
  assert.equal(r7.status, 200)
  assert.equal((await r7.json()).model, "model-b2")
  // 6a. Image-generation skill can be installed into the global OpenCode skills directory.
  const skillBefore = await (await fetch(`${base(PROXY)}/api/skills/image-generation`)).json()
  assert.equal(skillBefore.installed, false)
  assert.equal(skillBefore.path, join(skillDir, "image-generation", "SKILL.md"))
  const skillInstall = await fetch(`${base(PROXY)}/api/skills/image-generation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  assert.equal(skillInstall.status, 200)
  const installedSkill = await skillInstall.json()
  assert.equal(installedSkill.same, true)
  const skillText = readFileSync(installedSkill.path, "utf8")
  assert.match(skillText, /^---\nname: image-generation\ndescription: /, "installed skill should have OpenCode frontmatter")
  assert.ok(skillText.includes("# Генерация изображений через Provider Proxy"))
  assert.ok(skillText.includes("/api/image-tasks"), "skill should document the Provider Proxy image API")
  assert.ok(skillText.includes("Изображения/generated-output"), "skill should define the default image output directory")
  assert.ok(skillText.includes("curl"), "skill should document the curl fallback")
  assert.ok(skillText.includes("только модели из `providers.<provider>.models`"), "skill must use Connections, not cached catalog models")
  const skillAfter = await (await fetch(`${base(PROXY)}/api/skills/image-generation`)).json()
  assert.equal(skillAfter.same, true)
  // 6b. GUI: image task creation and polling stay behind the proxy credentials.
  const imageCreate = await fetch(`${base(PROXY)}/api/image-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "B", model: "model-b2", prompt: "a test image", ratio: "square", size: "1024x1024" }),
  })
  assert.equal(imageCreate.status, 200)
  const imageTask = await imageCreate.json()
  assert.equal(imageTask.task_id, "task-1")
  assert.deepEqual(imageTask.received, { model: "model-b2", prompt: "a test image", ratio: "square", size: "1024x1024" })
  const imageResult = await fetch(`${base(PROXY)}/api/image-tasks/B/task-1`)
  assert.equal(imageResult.status, 200)
  assert.equal((await imageResult.json()).result.url, "https://example.test/generated.png")
  const syncImageCreate = await fetch(`${base(PROXY)}/api/image-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "B", model: "model-b3", prompt: "a sync test image" }),
  })
  assert.equal(syncImageCreate.status, 200)
  const syncImage = await syncImageCreate.json()
  assert.equal(syncImage.data[0].url, "https://example.test/generated-sync.png")
  const failedImage = await fetch(`${base(PROXY)}/api/image-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "B", model: "model-error", prompt: "a failed image" }),
  })
  assert.equal(failedImage.status, 502)
  const failedImagePayload = await failedImage.json()
  assert.equal(failedImagePayload.provider, "B")
  assert.equal(failedImagePayload.model, "model-error")
  assert.ok(failedImagePayload.requestBytes > 0)
  assert.ok(Array.isArray(failedImagePayload.suggestedModels))
  assert.deepEqual(failedImagePayload.suggestedModels, ["B/model-b2", "B/model-b3"], "suggestions must use Connections and ignore the obsolete allowlist")
  const imageUsage = await (await fetch(`${base(PROXY)}/api/usage`)).json()
  assert.equal(imageUsage.images["B/model-b2"].requests, 1)
  assert.equal(imageUsage.images["B/model-b2"].ok, 1)
  assert.equal(imageUsage.images["B/model-b3"].requests, 1)
  assert.equal(imageUsage.images["B/model-b3"].ok, 1)
  assert.equal(imageUsage.imagesGenerated, 2)
  assert.equal(imageUsage.images["B/model-error"].errors, 1)
  const imageLogs = await (await fetch(`${base(PROXY)}/api/logs`)).json()
  assert.ok(imageLogs.lines.some((line) => line.includes("image tasks/task-1 B") && line.includes("HTTP 200")))
  assert.ok(imageLogs.lines.some((line) => line.includes("image images/generations B/model-b3") && line.includes("HTTP 200")))
  assert.ok(imageLogs.lines.some((line) => line.includes("image images/tasks B/model-error") && line.includes("HTTP 503")))
  assert.ok(imageLogs.lines.some((line) => line.includes("image request B/model-error:") && line.includes("bytes")))
  const direct = await post("B/model-b2")
  assert.equal(direct.status, 200)
  assert.equal((await direct.json()).model, "model-b2")
  const paused = await post("paused")
  assert.equal(paused.status, 200, "disabled chains remain available to the local proxy")
  assert.equal((await paused.json()).model, "model-b")
  const r5b = await fetch(`${base(PROXY)}/api/provider-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "B" }),
  })
  assert.deepEqual((await r5b.json()).models, ["model-b", "model-b2", "model-b3"])
  const safeConfig = await (await fetch(`${base(PROXY)}/api/config`)).json()
  assert.equal(safeConfig.appVersion, "0.1.5", "config should expose the application version")
  assert.equal(safeConfig.providers.B.apiKey, "", "GUI config must not receive the plaintext provider key")
  assert.equal(safeConfig.providers.B.apiKeyConfigured, true)
  assert.equal(safeConfig.models.paused.enabled, false, "disabled chain state should persist")
  const fullExportResponse = await fetch(`${base(PROXY)}/api/config/export`)
  assert.equal(fullExportResponse.status, 200)
  assert.match(fullExportResponse.headers.get("content-disposition"), /provider-proxy-config\.json/)
  const fullExport = await fullExportResponse.json()
  assert.equal(fullExport.providers.B.apiKey, "key-b", "full export should include provider keys")
  assert.ok(fullExport.models.fresh && fullExport.opencodeModels.B, "full export should include chains and direct models")
  const publicExport = await (await fetch(`${base(PROXY)}/api/config/export?keys=0&chains=0&models=0`)).json()
  assert.equal(publicExport.providers.B.apiKey, undefined, "keyless export must omit provider keys")
  assert.equal(publicExport.models, undefined, "optional chain export should be omittable")
  assert.equal(publicExport.opencodeModels, undefined, "optional direct model export should be omittable")
  const partialImport = await fetch(`${base(PROXY)}/api/config/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appSettings: { theme: "light" } }),
  })
  assert.equal(partialImport.status, 200)
  const afterPartialImport = await (await fetch(`${base(PROXY)}/api/config`)).json()
  assert.equal(afterPartialImport.models.fresh.upstreams.length, 2, "omitted chains must survive partial import")
  const database = new DatabaseSync(join(cfgDir, "config.db"))
  const storedConfig = database.prepare("SELECT value FROM settings WHERE key = 'config'").get()?.value ?? ""
  assert.ok(storedConfig.includes("enc:v1:"), "provider keys should be encrypted at rest in SQLite")
  assert.ok(!storedConfig.includes('"apiKey": "key-b"'), "plaintext provider key must not remain in SQLite")
  assert.ok(database.prepare("SELECT COUNT(*) AS count FROM usage_days").get().count > 0, "usage history should be stored in SQLite")
  database.close()

  // 6b. opencode sync: the chain list lands in opencode's config (opencode cannot fetch /v1/models itself).
  const oc = JSON.parse(readFileSync(ocCfg, "utf8"))
  assert.deepEqual(Object.keys(oc.providers["provider-proxy"].models), ["fresh", "B/model-b2"])
  assert.equal(oc.providers["provider-proxy"].models.paused, undefined, "disabled chains must be omitted from OpenCode")
  assert.equal(oc.providers["provider-proxy"].models.fresh.name, "fresh (proxy, x2)")
  assert.equal(oc.providers["provider-proxy"].models.fresh.limit.context, 32768, "chain context should use the smallest upstream context")
  assert.equal(oc.providers["provider-proxy"].models["B/model-b2"].name, "B/model-b2 (config)")
  assert.equal(oc.providers["provider-proxy"].models["B/model-b2"].limit.context, 32768, "model context should reach OpenCode")
  assert.equal(oc.providers["provider-proxy"].settings.baseURL, `${base(PROXY)}/v1`)
  assert.equal(oc.providers.other.name, "Other") // чужие провайдеры не тронуты
  assert.equal(statSync(ocCfg).ino, ocInode) // файл перезаписан НА МЕСТЕ: opencode перечитывает только так
  assert.ok(existsSync(ocCfg + ".bak")) // предыдущая версия рядом
  const syncRes = await (await fetch(`${base(PROXY)}/api/opencode-sync`, { method: "POST" })).json()
  assert.equal(syncRes.ok, true)
  assert.equal(syncRes.models, 2)
  const disableDirect = await fetch(`${base(PROXY)}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      port: PROXY,
      opencodeConfig: ocCfg,
      providers: {
        B: {
          baseURL: `${base(B)}/v1`,
          apiKey: "key-b",
          modelInfo: { "model-b2": { type: "image", endpoints: ["images/tasks"] }, "model-b3": { endpoints: ["images/generations"] } },
        },
      },
      models: {
        fresh: { upstreams: [{ provider: "B", model: "model-b2" }, { provider: "B", model: "model-b" }] },
        paused: { enabled: false, upstreams: [{ provider: "B", model: "model-b" }] },
      },
      opencodeModels: { B: { enabled: false, models: ["model-b2"] } },
    }),
  })
  assert.equal(disableDirect.status, 200)
  assert.equal((await disableDirect.json()).opencodeSynced, true)
  const ocDisabled = JSON.parse(readFileSync(ocCfg, "utf8"))
  assert.equal(ocDisabled.providers["provider-proxy"].models["B/model-b2"], undefined, "disabled direct provider must be omitted from OpenCode")

  // 7. Closing the GUI tab exits the server (timers shortened via env).
  const cfg2 = join(cfgDir, "config2.json")
  writeFileSync(cfg2, JSON.stringify({ port: 48791, models: {} }))
  const child2 = spawn(process.execPath, [join(here, "server.mjs"), cfg2], {
    env: { ...process.env, PP_CONFIG_KEY_FILE: keyFile, PP_GUI_LOST_MS: "300", PP_V1_QUIET_MS: "200" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out2 = ""
  child2.stdout.on("data", (d) => (out2 += d))
  child2.stderr.on("data", (d) => (out2 += d))
  const deadline2 = Date.now() + 5000
  while (Date.now() < deadline2) {
    try {
      await fetch(`${base(48791)}/api/ping`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000)
    child2.on("exit", () => {
      clearTimeout(t)
      resolve(true)
    })
  })
  assert.equal(exited, true, "server should exit after the GUI heartbeat stops\n" + out2)

  // 8. Privacy: the GUI must not load anything external (no CDN scripts/styles, no absolute fetch targets).
  const html = readFileSync(join(here, "public", "index.html"), "utf8")
  assert.ok(!/<script[^>]*\ssrc=/.test(html), "GUI must not load external scripts")
  assert.ok(!/<link[^>]*\shref=/.test(html.replace(/href="data:[^"]*"/g, "")), "GUI must not load external styles") // data:-URI — инлайн, не внешний ресурс
  assert.ok(!/fetch\(\s*["'`]https?:\/\//.test(html), "GUI fetch targets must be relative")
  assert.ok(!/["'`]wss?:\/\//.test(html), "GUI must not open external sockets")
  assert.match(html, /data-tab="usage">[\s\S]*?Статистика/, "usage tab should be renamed to Статистика")
  assert.ok(html.includes('id="u-donut-ok"'), "statistics should include the outcomes chart")
  assert.ok(html.includes('id="u-token-chart"'), "statistics should include the token chart")
  assert.match(html, /\["m", 1e6\]/, "token formatter should support millions")
  assert.ok(html.includes("999,999 should become 1m"), "token formatter should promote rounded 1000k to 1m")
  assert.ok(!html.includes("работает локально"), "GUI should not show the local-status label")
    assert.ok(html.includes('class="settings-nav-button" data-tab="settings"'), "settings should be available from the navigation")
   assert.ok(html.includes('id="update-banner"') && html.includes("checkForDesktopUpdate"), "desktop updates should be offered in the top-right banner")
    assert.ok(html.includes('id="s-theme"') && html.includes('id="s-autostart"'), "settings should expose theme and autostart")
    assert.ok(html.includes('id="s-create-shortcut"') && html.includes("create_app_shortcut"), "settings should expose app shortcut creation")
   assert.ok(html.includes('id="s-auto-update"') && html.includes('id="s-auto-restart"'), "settings should expose automatic update controls")
  assert.ok(html.includes('<svg viewBox="0 0 24 24"'), "settings button should use an inline vector icon")
  assert.ok(!html.includes("⚙"), "settings button should not use an emoji icon")
  assert.ok(html.includes('id="providers-filter"'), "providers tab should include a provider search")
  assert.ok(html.includes('id="pm-provider"'), "connections tab should keep the provider selector")
  assert.ok(html.includes('id="pm-provider-filter"') && html.includes('id="pm-provider-options"'), "connections tab should use provider tablets")
  const tabOrder = [...html.matchAll(/<button data-tab="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(tabOrder.slice(0, 8), ["providers", "connections", "integrations", "chains", "models", "images", "logs", "usage"], "tabs should be ordered providers, connections, integrations, chains, models, images, logs, usage")
  assert.ok(html.includes('id="s-limit"') && html.includes('Блокировка после лимита'), "cooldown duration should be editable")
  assert.ok(html.includes('data-a="toggle"') && html.includes("enabled !== false"), "chains should have an enable toggle and OpenCode filter")
  assert.match(html, /data-tab="connections">[\s\S]*?2&nbsp;·&nbsp;Модели провайдеров/, "connections should remain the second tab with the old provider-model UI")
  assert.match(html, /data-tab="integrations">[\s\S]*?3&nbsp;·&nbsp;Интеграции/, "integrations should remain the third tab")
  assert.ok(!html.includes('id="chain-oc-path"') && !html.includes('id="chain-m-sync"') && !html.includes('id="m-sync"'), "OpenCode panel should not be duplicated on model tabs")
  assert.match(html, /data-tab="chains">[\s\S]*?4&nbsp;·&nbsp;Цепочки/, "chains tab should follow integrations")
  assert.match(html, /data-tab="models">[\s\S]*?5&nbsp;·&nbsp;Модели/, "models tab should follow chains")
  assert.match(html, /data-tab="images">[\s\S]*?6&nbsp;·&nbsp;Генерация изображений/, "images tab should follow integrations")
  assert.ok(html.includes('id="om-add"') && html.includes('id="dom-provider-options"'), "direct model dialog should use the provider picker")
  assert.ok(html.includes('id="dom-model-list"'), "direct model dialog should choose provider models")
  assert.ok(html.includes('id="opencode-models"'), "models tab should render direct OpenCode models")
  assert.ok(html.includes("renderOpenCodePreview") && html.includes("slice(0, 10)"), "OpenCode previews should collapse after 10 entries")
  assert.ok(html.includes("Показать ещё") && html.includes("Свернуть список"), "OpenCode previews should have expand and collapse controls")
  assert.ok(!html.includes("(config)"), "direct models should not expose an integration-specific config label")
  assert.ok(html.includes("cfg.opencodeModels[provider].enabled = false"), "direct provider toggle should persist disabled state")
  assert.ok(html.includes('target.closest(".chain-toggle")') && html.includes("event.preventDefault()"), "provider toggles should handle clicks on the whole pill")
  assert.ok(html.includes('target.closest("#opencode-models .card[data-provider]")') && html.includes("openOpenCodeModelDialog(provider)"), "direct model actions should have delegated click handling")
  assert.ok(html.includes("modelAvailability") && html.includes("availabilityBadge"), "provider refresh should preserve and mark models missing from /v1/models")
  assert.ok(html.includes("⚠ не найдена"), "missing provider models should have a warning badge")
  assert.ok(html.includes('id="oc-path"') && html.includes('id="oc-provider"'), "OpenCode settings should be editable from the integrations tab")
  assert.ok(html.includes('id="opencode-enabled"') && html.includes('id="opencode-sync"') && html.includes("cfg.integrations.opencode.enabled = false"), "OpenCode integration should be switchable")
  assert.ok(html.includes('id="dm-provider-options"'), "chain editor should use a searchable provider picker")
  assert.ok(html.includes("proxy, x"), "OpenCode preview should show proxy chain length")
  assert.ok(html.includes("All модели провайдера") || html.includes("уже добавлены в цепочку"), "chain picker should hide models already in the chain")
  assert.ok(html.includes("contextLength"), "GUI should render context metadata from /v1/models")
  assert.ok(html.includes('data-tab="images"'), "image generation should have a dedicated tab")
  assert.ok(html.includes('id="ig-model"') && html.includes('id="ig-prompt"'), "image tab should choose a model and prompt")
  assert.ok(html.includes('id="ig-settings-open"') && html.includes('id="dlg-image-settings"'), "image tab should expose image settings")
  assert.match(html, /data-tab="integrations">[\s\S]*?id="image-skill-install"/, "integrations should expose image skill installation")
  assert.ok(html.includes('id="image-skill-install"') && html.includes("/api/skills/image-generation"), "integrations should install the harness skill")
  assert.ok(html.includes("const apiErrorMessage"), "GUI should render structured API errors instead of [object Object]")
  assert.ok(html.includes('id="settings-shutdown"') && html.includes("Выйти из приложения") && html.includes("/api/shutdown"), "main settings should expose full application exit")
  assert.ok(html.includes("window.close()"), "full application exit should try to close the browser tab")
  assert.ok(html.includes('id="ig-image-file"') && html.includes('accept="image/*"'), "image tab should support file references")
  assert.ok(html.includes("/api/image-tasks"), "image tab should use the proxy image task API")
  assert.ok(html.includes("isImageModel") && html.includes("model-kind-icon"), "image models should be marked in the connections picker")
  assert.ok(html.includes("imageModelEndpoint") && html.includes("endpoints"), "image generation should respect provider model endpoints")
  assert.ok(html.includes("removeModelFromChains") && html.includes("removeImageModelsFromChains"), "deselected and image models should be removed from chains")
  assert.ok(html.includes('id="dom-select-all"') && html.includes("выбрать все доступные модели"), "OpenCode model dialog should support select all")
  assert.ok(html.includes('id="u-images"') && html.includes('id="u-image-tiles"'), "usage should include image statistics")
  assert.ok(html.includes('id="u-days"') && html.includes("сохранено между сессиями"), "usage should provide persisted daily history")

  // 9. Logs ring: served to the GUI and capped (self-cleaning).
  const logRes = await (await fetch(`${base(PROXY)}/api/logs`)).json()
  assert.ok(logRes.lines.length > 0, "logs should have lines")
  assert.ok(logRes.lines.length <= logRes.max, "logs ring must not exceed its cap")
  assert.ok(logRes.lines.some((l) => l.includes("ответ: B")), "log should record which upstream answered")
  assert.ok(!logRes.lines.some((l) => l.includes("gui:")), "GUI debug events must stay out of model logs")

  // 10. Usage dashboard: requests, failover, per-provider 429 and token tallies.
  const u = await (await fetch(`${base(PROXY)}/api/usage`)).json()
  assert.equal(u.requests, 10) // r1, stream, incomplete stream, broken stream, r2, tool request, ri, r7, direct, paused — not the /v1/models GET nor the unknown model
  assert.equal(u.ok, 10)
  assert.equal(u.failovers, 2) // r1 (429 off A) and 2b (400 off A)
  assert.equal(u.failed, 0)
  assert.equal(u.skipped, 0, "a request that reached an upstream is never counted as skipped")
  assert.equal(u.providers.A.requests, 2)
  assert.equal(u.providers.A.limits, 1)
  assert.equal(u.providers.A.errors, 1) // 400 unsupported on the img chain
  assert.equal(u.providers.B.ok, 10)
  assert.equal(u.models.test.requests, 6)
  assert.equal(u.models.img.requests, 1)
  assert.equal(u.models.fresh.requests, 1)
  assert.equal(u.models.paused.requests, 1)
  assert.equal(u.models["B/model-b2"].requests, 1)
  assert.equal(u.tokensIn, 77) // 7 successful chats x 11 prompt tokens from B
  assert.equal(u.tokensOut, 154)
  assert.equal(u.tokensIn, 77)
  assert.equal(u.lifetimeTokens?.tokensIn, 77, "lifetime totals must be exposed to the GUI")
  assert.equal(u.lifetimeTokens?.tokensOut, 154)
  assert.equal(u.retentionDays, 7)
  assert.equal(u.days.length, 7)
  assert.equal(u.days[0].date, dayKey(0))
  assert.equal(u.days[0].requests, 10)
  assert.equal(u.days.find((day) => day.date === dayKey(-1)).requests, 3, "yesterday should remain a separate persisted day")
  assert.equal(u.days.find((day) => day.date === dayKey(-8)), undefined, "history older than seven days must be pruned")
  assert.ok(u.cooldowns.length >= 1 && u.cooldowns.every((c) => c.upstream === "A")) // A cooling after 429/400
  assert.ok(u.uptimeMs >= 0)

  // 11. Main settings can stop the whole proxy process, not only close the dialog.
  const shutdownExited = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  const shutdownResponse = await fetch(`${base(PROXY)}/api/shutdown`, { method: "POST" })
  assert.equal(shutdownResponse.status, 200)
  assert.deepEqual(await shutdownResponse.json(), { ok: true, stopping: true })
  assert.equal(await shutdownExited, true, "shutdown endpoint should terminate the proxy process")

  // 12. Daily usage survives a full proxy restart.
  restartedChild = spawn(process.execPath, [join(here, "server.mjs"), cfg], {
    env: { ...process.env, HOME: skillHome, PP_CONFIG_KEY_FILE: keyFile, PP_STATS_FILE: statsFile },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let restartedOut = ""
  restartedChild.stdout.on("data", (data) => (restartedOut += data))
  restartedChild.stderr.on("data", (data) => (restartedOut += data))
  const restartDeadline = Date.now() + 5000
  let restartedReady = false
  while (Date.now() < restartDeadline) {
    try {
      await fetch(`${base(PROXY)}/api/ping`)
      restartedReady = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  assert.equal(restartedReady, true, `proxy did not restart:\n${restartedOut}`)
  const afterRestart = await (await fetch(`${base(PROXY)}/api/usage`)).json()
  assert.equal(afterRestart.days.find((day) => day.date === dayKey(0)).requests, 10, "today stats should survive restart")
  assert.equal(afterRestart.days.find((day) => day.date === dayKey(-1)).requests, 3, "previous day stats should survive restart")
  const restartShutdown = await fetch(`${base(PROXY)}/api/shutdown`, { method: "POST" })
  assert.equal(restartShutdown.status, 200)
  await new Promise((resolve) => restartedChild.once("exit", resolve))

  console.log("OK: failover, cooldown skip, unsupported-400 failover, mapping, catalog, GUI page, provider models, config hot-reload, tab-close exit, privacy, logs, usage, opencode sync, full shutdown")
} finally {
  await stopChild(child)
  await stopChild(restartedChild)
  upstreamA.close()
  upstreamB.close()
  rmSync(cfgDir, { recursive: true, force: true })
}
