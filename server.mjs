#!/usr/bin/env node
// provider_proxy — OpenAI-compatible proxy with automatic upstream failover.
// One exposed "model" = an ordered chain of upstreams; on daily limit (429),
// outage (5xx) or network error the next upstream is tried automatically.
// shortcut: upstreams must be OpenAI-compatible (POST {baseURL}/chat/completions);
// native Anthropic/Google protocols are not translated.

import http from "node:http"
import { once } from "node:events"
import { Readable } from "node:stream"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const configPath = process.argv[2] ?? join(here, "config.json")
// In-memory log ring the GUI reads; old lines fall off on their own (nothing is written to disk).
const LOG_MAX = Number(process.env.PP_LOG_LINES) || 500
const logs = []
// Local date+time: 2026-10-20 13:45:12 (server timezone).
const fmtTs = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const log = (...a) => {
  const text = a.map((x) => (typeof x === "string" ? x : (x?.stack ?? String(x)))).join(" ")
  const line = `[${fmtTs()}] ${text}`
  console.log(line)
  logs.push(line)
  if (logs.length > LOG_MAX) logs.shift()
}

let config
try {
  config = JSON.parse(readFileSync(configPath, "utf8"))
} catch (err) {
  if (err.code !== "ENOENT") throw err
  // No config yet: start from the example (shape + {env:...} keys) or scratch, and let the GUI fill it in.
  const example = join(here, "config.example.json")
  config = existsSync(example) ? JSON.parse(readFileSync(example, "utf8")) : {}
  log(
    `no config at ${configPath}; starting from ${existsSync(example) ? "config.example.json" : "scratch"} — first GUI save writes ${configPath}`,
  )
}
let PORT, AUTH, LIMIT_COOLDOWN_MS, ERROR_COOLDOWN_MS, HEADER_TIMEOUT_MS
let chains = new Map()

const INDEX_HTML = (() => {
  const p = join(here, "public", "index.html")
  return existsSync(p) ? readFileSync(p, "utf8") : ""
})()

// "{env:NAME}" substitution so API keys can stay out of the config file.
const subst = (v) =>
  typeof v === "string" ? v.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] ?? "") : v

// (Re)build runtime state from the config. Called at startup and after every GUI save.
// Reads both shapes: new { providers: {...}, models: { m: { upstreams: [{provider, model}] } } }
// and legacy inline upstreams { name, baseURL, apiKey, model }.
const safeHost = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
function applyConfig(c) {
  const next = new Map()
  for (const [name, def] of Object.entries(c.models ?? {})) {
    next.set(
      name,
      (def.upstreams ?? [])
        .map((u) => {
          const p = u.provider ? (c.providers ?? {})[u.provider] : u
          if (!p?.baseURL) return null
          return {
            name: u.provider ?? p.name ?? safeHost(p.baseURL),
            baseURL: String(p.baseURL).replace(/\/+$/, ""),
            model: u.model ?? name,
            apiKey: subst(p.apiKey ?? ""),
            headers: Object.fromEntries(Object.entries(u.headers ?? p.headers ?? {}).map(([k, v]) => [k, subst(v)])),
          }
        })
        .filter(Boolean),
    )
  }
  config = c
  chains = next
  PORT = c.port ?? 8787
  AUTH = c.authToken
  LIMIT_COOLDOWN_MS = (c.limitCooldownSec ?? 300) * 1000 // 429/403/402: block provider 5 min then try again
  ERROR_COOLDOWN_MS = (c.errorCooldownSec ?? 30) * 1000 // 5xx/network: transient
  HEADER_TIMEOUT_MS = (c.headerTimeoutSec ?? 20) * 1000 // abort if no response headers in time
  for (const [name, chain] of chains)
    for (const up of chain)
      if (!up.apiKey && !up.headers.authorization) log(`warn: upstream ${up.name} (model "${name}") has no apiKey`)
}
applyConfig(config)

// Cooldown bookkeeping: "model|upstream-index" -> skip-until timestamp.
// In-memory only: a proxy restart forgets cooldowns (they are cheap to re-learn).
const cooldowns = new Map()
const cooling = (key) => (cooldowns.get(key) ?? 0) > Date.now()
const cool = (key, ms) => cooldowns.set(key, Date.now() + ms)

// Usage counters for the GUI dashboard: in-memory, wiped on restart (nothing stored on disk).
const usage = { since: Date.now(), requests: 0, ok: 0, failed: 0, failovers: 0, tokensIn: 0, tokensOut: 0, providers: {}, models: {} }
const statP = (name) => (usage.providers[name] ??= { requests: 0, ok: 0, limits: 0, errors: 0, tokensIn: 0, tokensOut: 0 })
const statM = (name) => (usage.models[name] ??= { requests: 0, ok: 0, failovers: 0, tokensIn: 0, tokensOut: 0 })

// Upstreams report usage only sometimes (always for non-streaming, and for streaming only when the
// client asked for it). Sniff the last "usage" object out of the response — the client's request is
// never modified, so nothing can break on providers that don't support it.
const tally = (text, ...stats) => {
  const u = String(text).match(/"usage"\s*:\s*\{[^}]*\}/g)?.at(-1)
  if (!u) return
  const num = (k) => Number(u.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`))?.[1]) || 0
  const tin = num("prompt_tokens")
  const tout = num("completion_tokens")
  for (const s of [usage, ...stats]) {
    s.tokensIn += tin
    s.tokensOut += tout
  }
}

const FAILOVER = (status) => status === 402 || status === 403 || status === 408 || status === 429 || status >= 500

// opencode не умеет сам брать список моделей у кастомного провайдера (GET /v1/models он не зовёт),
// поэтому карта моделей должна лежать в его конфиге. Синхронизируем её отсюда: провайдер — источник истины.
function syncOpencode() {
  const path = config.opencodeConfig ?? join(homedir(), ".config", "opencode", "opencode.jsonc")
  const id = config.opencodeProvider ?? "provider-proxy"
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    log(`opencode: нет файла ${path} — карта моделей не обновлена`)
    return false
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    log(`opencode: ${path} не читается как JSON (комментарии?) — карта моделей не обновлена`)
    return false
  }
  // в новых версиях opencode это "providers", в старых — "provider"
  const key = doc.providers ? "providers" : doc.provider ? "provider" : "providers"
  const section = (doc[key] ??= {})
  const p = (section[id] ??= {})
  p.package ??= "aisdk:@ai-sdk/openai-compatible"
  p.name ??= "Provider Proxy"
  p.settings ??= {}
  // локальный baseURL ведём по фактическому порту; удалённый (на другую машину) не трогаем
  const local = `http://127.0.0.1:${listenPort ?? PORT}/v1`
  if (!p.settings.baseURL || /^https?:\/\/(127\.0\.0\.1|localhost):/.test(p.settings.baseURL))
    p.settings.baseURL = local
  if (AUTH) p.settings.apiKey = AUTH
  const prev = p.models ?? {}
  p.models = {}
  for (const name of chains.keys()) {
    const old = prev[name] ?? {}
    p.models[name] = { name: old.name ?? `${name} (proxy)` }
    for (const [k, v] of Object.entries(old)) if (k !== "name") p.models[name][k] = v
  }
  // Пишем НА МЕСТЕ (тот же inode): opencode следит за файлом и перечитывает его только так.
  // rename() менял inode — opencode не подхватывал новые модели. Бэкап рядом, чтобы откатить руками.
  writeFileSync(path + ".bak", raw)
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
  log(`opencode: ${chains.size} моделей провайдера «${id}» записаны в ${path}`)
  return true
}

async function readBody(req) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw
}

let listenPort = null
let lastPing = null // last /api/ping from the GUI tab; null until the GUI is first opened
let lastV1 = 0 // last /v1/* request time
let active = 0 // in-flight proxied chat requests

const server = http.createServer(async (req, res) => {
  res.on("error", () => {}) // a client disconnecting mid-stream must not crash the proxy
  try {
    // The GUI page itself is public (localhost); its /api calls carry the token when authToken is set.
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(INDEX_HTML)
    }

    // Liveness heartbeat from the GUI tab; exempt from authToken so the tab can always keep us alive.
    if (req.method === "GET" && req.url === "/api/ping") {
      lastPing = Date.now()
      res.writeHead(200, { "content-type": "application/json" })
      return res.end("{}")
    }

    if (AUTH && req.headers.authorization !== `Bearer ${AUTH}`) {
      log(`401 ${req.method} ${req.url} — нет/неверный токен (authToken в config.json)`)
      res.writeHead(401, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: "bad proxy token" } }))
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      lastV1 = Date.now()
      log(`GET /v1/models → ${chains.size} моделей`)
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(
        JSON.stringify({
          object: "list",
          data: [...chains.keys()].map((id) => ({ id, object: "model", owned_by: "provider_proxy" })),
        }),
      )
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      lastV1 = Date.now()
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "invalid JSON body" } }))
      }
      return await proxyChat(body, res)
    }

    // ---- GUI API ----

    if (req.url === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(config))
    }

    if (req.url === "/api/config" && req.method === "PUT") {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "invalid JSON" }))
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body.models ?? {}) !== "object") {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "config must be an object with a models object" }))
      }
      applyConfig(body)
      writeFileSync(configPath, JSON.stringify(body, null, 2) + "\n")
      log(`config updated via GUI: ${Object.keys(body.providers ?? {}).length} providers, ${chains.size} models`)
      syncOpencode() // карта моделей в конфиге opencode — чтобы новые цепочки были видны сразу
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, restartRequired: (body.port ?? 8787) !== listenPort }))
    }

    // Fetch a provider's own /models list, for the GUI "Модели" button.
    if (req.url === "/api/provider-models" && req.method === "POST") {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        body = {}
      }
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 10_000)
        const resp = await fetch(`${String(body.baseURL ?? "").replace(/\/+$/, "")}/models`, {
          headers: { authorization: `Bearer ${subst(body.apiKey ?? "")}`, ...(body.headers ?? {}) },
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        const data = await resp.json().catch(() => ({}))
        const ids = (data.data ?? data.models ?? [])
          .map((m) => m?.id ?? m?.name ?? m)
          .filter((x) => typeof x === "string")
        res.writeHead(resp.ok ? 200 : 502, { "content-type": "application/json" })
        return res.end(JSON.stringify(resp.ok ? { models: ids } : { error: `HTTP ${resp.status}` }))
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: String(err.cause?.code ?? err.message) }))
      }
    }

    if (req.url === "/api/opencode-sync" && req.method === "POST") {
      const ok = syncOpencode()
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok, models: chains.size }))
    }

    if (req.url === "/api/logs" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ lines: logs, max: LOG_MAX }))
    }

    if (req.url === "/api/usage" && req.method === "GET") {
      const now = Date.now()
      const coolingNow = [...cooldowns]
        .filter(([, until]) => until > now)
        .map(([key, until]) => {
          const [model, upstream] = key.split("|")
          return { model, upstream, until }
        })
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ...usage, cooldowns: coolingNow, uptimeMs: now - usage.since }))
    }

    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${req.url}` } }))
  } catch (err) {
    log("error:", err)
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(err) } }))
    } else res.destroy()
  }
})

// "1m 30s" / "45s" / "5m" — human readable duration for log lines.
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m >= 1 ? `${m}m ${s % 60}s` : `${s}s`
}

async function proxyChat(body, res) {
  const exposed = body.model
  const chain = chains.get(exposed)
  if (!chain) {
    res.writeHead(404, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: { message: `unknown model: ${exposed}` } }))
  }

  // If the client (opencode) disconnects, drop the upstream call too.
  active++
  usage.requests++
  const mStat = statM(exposed)
  mStat.requests++
  let current = null
  res.on("close", () => {
    active--
    if (!res.writableEnded) current?.abort()
  })

  let lastError = "all upstreams are cooling down"
  for (let i = 0; i < chain.length; i++) {
    const up = chain[i]
    const key = `${exposed}|${up.name}|${up.model}` // stable under chain edits from the GUI
    if (cooling(key)) continue

    const ctrl = new AbortController()
    current = ctrl
    const pStat = statP(up.name)
    pStat.requests++
    const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS)
    try {
      const resp = await fetch(`${up.baseURL}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${up.apiKey}`, ...up.headers },
        body: JSON.stringify({ ...body, model: up.model }),
      })
      clearTimeout(timer)

      if (FAILOVER(resp.status)) {
        await resp.body?.cancel().catch(() => {}) // release the connection, we won't read it
        // honor Retry-After when present, clamped to [1s, 24h]
        const ra = Number(resp.headers.get("retry-after"))
        const def = resp.status === 429 ? LIMIT_COOLDOWN_MS : ERROR_COOLDOWN_MS
        const ms = Number.isFinite(ra) && ra > 0 ? Math.min(Math.max(ra * 1000, 1000), 86_400_000) : def
        cool(key, ms)
        lastError = `${up.name}: HTTP ${resp.status}`
        if (resp.status === 429) pStat.limits++
        else pStat.errors++
        usage.failovers++
        mStat.failovers++
        log(
          `${exposed} → свитч: ${up.name}/${up.model} заблокирован (HTTP ${resp.status}) на ${fmtDur(ms)}, пробую следующего`,
        )
        continue
      }

      // 400 "unsupported content" (например, провайдер не принимает картинки) — запрос не сломан,
      // он просто не по адресу: свитчимся, как при failover. Прочий 400 повторился бы на любом
      // апстриме (кривой запрос) — отдаём клиенту как есть.
      if (resp.status === 400) {
        const t = await resp.text().catch(() => "")
        if (/unsupported|not support/i.test(t)) {
          cool(key, ERROR_COOLDOWN_MS)
          lastError = `${up.name}: HTTP 400, запрос не поддерживается`
          pStat.errors++
          usage.failovers++
          mStat.failovers++
          log(
            `${exposed} → свитч: ${up.name}/${up.model} не поддерживает запрос (HTTP 400) на ${fmtDur(ERROR_COOLDOWN_MS)}, пробую следующего`,
          )
          continue
        }
        log(`${exposed} → ошибка: ${up.name}/${up.model} (HTTP 400)`)
        res.writeHead(400, { "content-type": resp.headers.get("content-type") ?? "application/json" })
        return res.end(t)
      }

      // Success, or a client error that would repeat on every upstream (401, 404...): pass through untouched.
      log(`${exposed} → ${resp.ok ? "ответ" : "ошибка"}: ${up.name}/${up.model} (HTTP ${resp.status})`)
      const headers = Object.fromEntries(resp.headers)
      // undici may hand us a decoded body; stale framing headers would corrupt the passthrough
      delete headers["content-encoding"]
      delete headers["content-length"]
      delete headers["transfer-encoding"]
      delete headers["connection"]
      res.writeHead(resp.status, headers)
      usage.ok++
      pStat.ok++
      mStat.ok++
      if (!resp.body) return res.end()

      // Stream the body through untouched, watching for a usage report on the way (see tally()).
      const isSse = (resp.headers.get("content-type") ?? "").includes("text/event-stream")
      try {
        if (isSse) {
          let tail = ""
          for await (const chunk of Readable.fromWeb(resp.body)) {
            tail = (tail + Buffer.from(chunk).toString("utf8")).slice(-8192) // usage arrives in the final chunk
            if (!res.write(chunk)) await once(res, "drain")
          }
          res.end()
          tally(tail, pStat, mStat)
        } else {
          const chunks = []
          for await (const chunk of Readable.fromWeb(resp.body)) chunks.push(chunk)
          const text = Buffer.concat(chunks).toString("utf8")
          res.end(text)
          tally(text, pStat, mStat)
        }
      } catch {
        if (!res.writableEnded) res.destroy() // client went away mid-stream
      }
      return
    } catch (err) {
      clearTimeout(timer)
      if (res.destroyed) return // client is gone, nothing to fail over to
      cool(key, ERROR_COOLDOWN_MS)
      pStat.errors++
      usage.failovers++
      mStat.failovers++
      lastError = `${up.name}: ${err.name === "AbortError" ? "timeout" : (err.cause?.code ?? err.message)}`
      log(
        `${exposed} → свитч: ${up.name}/${up.model} заблокирован (${lastError}) на ${fmtDur(ERROR_COOLDOWN_MS)}, пробую следующего`,
      )
    }
  }

  usage.failed++
  res.writeHead(502, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: `all upstreams failed for ${exposed}: ${lastError}` } }))
}

// ---- lifetime: die with the GUI tab ----
// The GUI pings /api/ping every 5s while its tab is open. Once pings stop (tab closed)
// and no proxied request is in flight or recent, the server exits on its own.
const GUI_LOST_MS = Number(process.env.PP_GUI_LOST_MS) || 15_000
const V1_QUIET_MS = Number(process.env.PP_V1_QUIET_MS) || 60_000
setInterval(() => {
  if (lastPing === null) return // GUI never opened (manual run): stay up
  if (Date.now() - lastPing < GUI_LOST_MS) return // tab still open
  if (active > 0 || Date.now() - lastV1 < V1_QUIET_MS) return // opencode still needs the proxy
  log("GUI tab closed and no active traffic — exiting")
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}, Math.min(5000, Math.max(500, GUI_LOST_MS / 3)))

server.listen(PORT, "127.0.0.1", () => {
  listenPort = PORT
  log(
    `provider_proxy on http://127.0.0.1:${listenPort}/v1 — GUI: http://127.0.0.1:${listenPort}/ (${chains.size} models, config: ${configPath})`,
  )
})
