// Smoke test: 429 failover, cooldown skip, model/key mapping, catalog, unknown model,
// GUI page, provider model list, config hot-reload via PUT /api/config.
// Run: node test.mjs   (mock upstreams + proxy on ports 48787-48789)
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const PROXY = 48787,
  A = 48788,
  B = 48789
const base = (p) => `http://127.0.0.1:${p}`

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
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-b2" }] }))
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

const child = spawn(process.execPath, [join(here, "server.mjs"), cfg], { stdio: ["ignore", "pipe", "pipe"] })
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

  // 2. A is cooling down -> skipped without a round-trip.
  const r2 = await post("test")
  assert.equal(r2.status, 200)
  assert.equal((await r2.json()).ok, true)
  assert.equal(aHits, 1)

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
  assert.deepEqual((await r5.json()).models, ["model-b", "model-b2"])

  // 6. GUI: PUT /api/config hot-reloads chains (provider refs, new format).
  const r6 = await fetch(`${base(PROXY)}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      opencodeConfig: ocCfg,
      providers: { B: { baseURL: `${base(B)}/v1`, apiKey: "key-b" } },
      models: { fresh: { upstreams: [{ provider: "B", model: "model-b2" }] } },
    }),
  })
  assert.equal(r6.status, 200)
  const r7 = await post("fresh")
  assert.equal(r7.status, 200)
  assert.equal((await r7.json()).model, "model-b2")

  // 6b. opencode sync: the chain list lands in opencode's config (opencode cannot fetch /v1/models itself).
  const oc = JSON.parse(readFileSync(ocCfg, "utf8"))
  assert.deepEqual(Object.keys(oc.providers["provider-proxy"].models), ["fresh"])
  assert.equal(oc.providers["provider-proxy"].models.fresh.name, "fresh (proxy)")
  assert.equal(oc.providers["provider-proxy"].settings.baseURL, `${base(PROXY)}/v1`)
  assert.equal(oc.providers.other.name, "Other") // чужие провайдеры не тронуты
  assert.equal(statSync(ocCfg).ino, ocInode) // файл перезаписан НА МЕСТЕ: opencode перечитывает только так
  assert.ok(existsSync(ocCfg + ".bak")) // предыдущая версия рядом
  const syncRes = await (await fetch(`${base(PROXY)}/api/opencode-sync`, { method: "POST" })).json()
  assert.equal(syncRes.ok, true)
  assert.equal(syncRes.models, 1)

  // 7. Closing the GUI tab exits the server (timers shortened via env).
  const cfg2 = join(cfgDir, "config2.json")
  writeFileSync(cfg2, JSON.stringify({ port: 48791, models: {} }))
  const child2 = spawn(process.execPath, [join(here, "server.mjs"), cfg2], {
    env: { ...process.env, PP_GUI_LOST_MS: "300", PP_V1_QUIET_MS: "200" },
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

  // 9. Logs ring: served to the GUI and capped (self-cleaning).
  const logRes = await (await fetch(`${base(PROXY)}/api/logs`)).json()
  assert.ok(logRes.lines.length > 0, "logs should have lines")
  assert.ok(logRes.lines.length <= logRes.max, "logs ring must not exceed its cap")
  assert.ok(logRes.lines.some((l) => l.includes("ответ: B")), "log should record which upstream answered")

  // 10. Usage dashboard: requests, failover, per-provider 429 and token tallies.
  const u = await (await fetch(`${base(PROXY)}/api/usage`)).json()
  assert.equal(u.requests, 4) // r1, r2, ri, r7 — not the /v1/models GET nor the unknown model
  assert.equal(u.ok, 4)
  assert.equal(u.failovers, 2) // r1 (429 off A) and 2b (400 off A)
  assert.equal(u.failed, 0)
  assert.equal(u.providers.A.requests, 2)
  assert.equal(u.providers.A.limits, 1)
  assert.equal(u.providers.A.errors, 1) // 400 unsupported on the img chain
  assert.equal(u.providers.B.ok, 4)
  assert.equal(u.models.test.requests, 2)
  assert.equal(u.models.img.requests, 1)
  assert.equal(u.models.fresh.requests, 1)
  assert.equal(u.tokensIn, 44) // 4 successful chats x 11 prompt tokens from B
  assert.equal(u.tokensOut, 88)
  assert.ok(u.cooldowns.length >= 1 && u.cooldowns.every((c) => c.upstream === "A")) // A cooling after 429/400
  assert.ok(u.uptimeMs >= 0)

  console.log("OK: failover, cooldown skip, unsupported-400 failover, mapping, catalog, GUI page, provider models, config hot-reload, tab-close exit, privacy, logs, usage, opencode sync")
} finally {
  child.kill()
  upstreamA.close()
  upstreamB.close()
  rmSync(cfgDir, { recursive: true, force: true })
}
