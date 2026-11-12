#!/usr/bin/env node
// provider_proxy — OpenAI-compatible proxy with automatic upstream failover.
// One exposed "model" = an ordered chain of upstreams; on daily limit (429),
// outage (5xx) or network error the next upstream is tried automatically.
// shortcut: upstreams must be OpenAI-compatible (POST {baseURL}/chat/completions);
// native Anthropic/Google protocols are not translated.

import http from "node:http"
import { once } from "node:events"
import { Readable } from "node:stream"
import { DatabaseSync } from "node:sqlite"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const configPath = process.argv[2] ?? join(here, "config.db")
const legacyConfigPath = /\.db$/i.test(configPath) ? configPath.replace(/\.db$/i, ".json") : configPath
const legacyStatsPath = process.env.PP_STATS_FILE ?? join(dirname(configPath), "usage-stats.json")
const dbPath = process.env.PP_DB_FILE ?? (/\.db$/i.test(configPath) ? configPath : configPath.replace(/\.[^/.]+$/, ".db"))
mkdirSync(dirname(dbPath), { recursive: true })
const database = new DatabaseSync(dbPath)
database.exec(`
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_days (
    day TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  );
`)
try { chmodSync(dbPath, 0o600) } catch { /* Windows or a read-only existing database */ }
const CONFIG_KEY_PREFIX = "enc:v1:"
const API_VERSION = 3
const APP_VERSION = "0.1.7"
const configKeyPath = process.env.PP_CONFIG_KEY_FILE ?? join(homedir(), ".config", "provider-proxy", "master.key")
let cachedConfigKey = null
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

const isEnvSecret = (value) => typeof value === "string" && /^\{env:[A-Za-z0-9_]+\}$/.test(value)
const isEncryptedSecret = (value) => typeof value === "string" && value.startsWith(CONFIG_KEY_PREFIX)
const collectStrings = (value, out = []) => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out)
  return out
}
const imageEndpointName = (value) => {
  const text = String(value ?? "").toLowerCase()
  if (text.includes("images/generations")) return "images/generations"
  if (text.includes("images/tasks")) return "images/tasks"
  return ""
}
const hasEncryptedSecrets = (value) => {
  if (typeof value === "string") return isEncryptedSecret(value)
  if (Array.isArray(value)) return value.some(hasEncryptedSecrets)
  if (!value || typeof value !== "object") return false
  return Object.values(value).some(hasEncryptedSecrets)
}
const clearUnreadableEncryptedSecrets = (value, parentKey = "") => {
  if (Array.isArray(value)) return value.map((item) => clearUnreadableEncryptedSecrets(item, parentKey))
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const sensitive = key === "apiKey" || key === "authToken" || parentKey === "headers"
    out[key] = sensitive && typeof item === "string" && isEncryptedSecret(item)
      ? ""
      : clearUnreadableEncryptedSecrets(item, key)
  }
  return out
}
const keyFromRaw = (raw) => createHash("sha256").update(raw).digest()
function configKey({ required = false } = {}) {
  if (cachedConfigKey) return cachedConfigKey
  const envKey = process.env.PP_CONFIG_KEY
  if (envKey) return (cachedConfigKey = keyFromRaw(envKey))
  try {
    const raw = readFileSync(configKeyPath)
    if (raw.length < 16) throw new Error(`config key file is too short: ${configKeyPath}`)
    return (cachedConfigKey = keyFromRaw(raw))
  } catch (err) {
    if (err.code !== "ENOENT" || required) {
      throw new Error(`cannot read provider_proxy encryption key (${configKeyPath}); set PP_CONFIG_KEY or restore the key file`)
    }
    mkdirSync(dirname(configKeyPath), { recursive: true, mode: 0o700 })
    const raw = randomBytes(32)
    writeFileSync(configKeyPath, raw, { mode: 0o600 })
    chmodSync(configKeyPath, 0o600)
    return (cachedConfigKey = keyFromRaw(raw))
  }
}
function encryptSecret(value) {
  if (typeof value !== "string" || !value || isEnvSecret(value) || isEncryptedSecret(value)) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", configKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return `${CONFIG_KEY_PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`
}
function decryptSecret(value) {
  if (!isEncryptedSecret(value)) return value
  const [, version, ivRaw, tagRaw, ciphertextRaw] = value.split(":")
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("invalid encrypted provider_proxy secret")
  try {
    const decipher = createDecipheriv("aes-256-gcm", configKey({ required: true }), Buffer.from(ivRaw, "base64url"))
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("cannot decrypt provider_proxy config; check PP_CONFIG_KEY or the private key file")
  }
}
function transformConfigSecrets(value, transform, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => transformConfigSecrets(item, transform, parentKey))
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const sensitive = key === "apiKey" || key === "authToken" || parentKey === "headers"
    out[key] = sensitive && typeof item === "string" ? transform(item) : transformConfigSecrets(item, transform, key)
  }
  return out
}
const decryptConfig = (value) => transformConfigSecrets(value, decryptSecret)
const encryptConfig = (value) => transformConfigSecrets(value, encryptSecret)
const decryptConfigWithFallback = (value) => {
  try {
    return decryptConfig(value)
  } catch (err) {
    // Keep the GUI usable when the key was removed while encrypted config remains.
    if (!hasEncryptedSecrets(value) || process.env.PP_CONFIG_KEY || existsSync(configKeyPath)) throw err
    const cleared = clearUnreadableEncryptedSecrets(value)
    log(`${err.message}; encrypted credentials were cleared in memory — re-enter them in Settings`)
    return cleared
  }
}
function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value))
}
const sensitiveHeader = (key) => /authorization|api[-_]?key|token|secret/i.test(key)
function publicConfig(value) {
  const redact = (item, parentKey = "") => {
    if (Array.isArray(item)) return item.map((child) => redact(child, parentKey))
    if (!item || typeof item !== "object") return item
    const out = {}
    for (const [key, value] of Object.entries(item)) {
      if ((key === "apiKey" || key === "authToken") && value) {
        out[key] = ""
        out[`${key}Configured`] = true
      } else if (parentKey === "headers" && sensitiveHeader(key)) {
        continue
      } else {
        out[key] = redact(value, key)
      }
    }
    return out
  }
  return redact(value)
}
function mergeRedactedSecrets(next, previous) {
  if (Array.isArray(next)) return next.map((item, index) => mergeRedactedSecrets(item, previous?.[index]))
  if (!next || typeof next !== "object") return next
  const out = {}
  for (const [key, value] of Object.entries(next)) {
    if ((key === "apiKey" || key === "authToken") && value === "" && next[`${key}Configured`] && previous?.[key]) {
      out[key] = previous[key]
    } else if (key === "headers" && value && typeof value === "object") {
      out[key] = mergeRedactedSecrets(value, previous?.[key])
      for (const [header, headerValue] of Object.entries(previous?.[key] ?? {})) {
        if (sensitiveHeader(header) && !(header in out[key])) out[key][header] = headerValue
      }
    } else if (!key.endsWith("Configured")) {
      out[key] = mergeRedactedSecrets(value, previous?.[key])
    }
  }
  return out
}
function mergeConfigSecrets(next, previous) {
  const out = cloneConfig(next)
  for (const [name, provider] of Object.entries(out.providers ?? {})) {
    const source = provider.apiKeySource ? previous.providers?.[provider.apiKeySource] : previous.providers?.[name]
    if (provider.apiKeyConfigured && !provider.apiKey && source?.apiKey) provider.apiKey = source.apiKey
    delete provider.apiKeyConfigured
    delete provider.apiKeySource
    if (provider.headersConfigured && source?.headers) {
      provider.headers = { ...source.headers, ...(provider.headers ?? {}) }
    }
    delete provider.headersConfigured
  }
  if (out.authTokenConfigured && !out.authToken && previous.authToken) out.authToken = previous.authToken
  delete out.authTokenConfigured
  return mergeRedactedSecrets(out, previous)
}
function exportConfig(value, { keys = true, chains = true, models = true } = {}) {
  const strip = (item, parentKey = "") => {
    if (Array.isArray(item)) return item.map((child) => strip(child, parentKey))
    if (!item || typeof item !== "object") return item
    const out = {}
    for (const [key, child] of Object.entries(item)) {
      if (!keys && (key === "apiKey" || key === "authToken" || (parentKey === "headers" && sensitiveHeader(key)))) continue
      out[key] = strip(child, key)
    }
    return out
  }
  const out = strip(value)
  if (!chains) delete out.models
  if (!models) delete out.opencodeModels
  return out
}
function mergeImportedConfig(next, previous) {
  const out = { ...cloneConfig(previous), ...cloneConfig(next) }
  if (Object.prototype.hasOwnProperty.call(next, "providers")) {
    out.providers = cloneConfig(next.providers)
    for (const [name, provider] of Object.entries(out.providers ?? {})) {
      const previousProvider = previous.providers?.[name]
      if (!Object.prototype.hasOwnProperty.call(provider, "apiKey") && previousProvider?.apiKey) provider.apiKey = previousProvider.apiKey
      if (provider.headers && previousProvider?.headers) {
        for (const [header, value] of Object.entries(previousProvider.headers)) {
          if (sensitiveHeader(header) && !Object.prototype.hasOwnProperty.call(provider.headers, header)) provider.headers[header] = value
        }
      }
    }
  }
  return mergeConfigSecrets(out, previous)
}
function validateImportedConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "config must be an object"
  for (const key of ["providers", "models", "opencodeModels"]) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) return `${key} must be an object`
  }
  return ""
}
function readStoredConfig() {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'config'").get()
  return row?.value ? JSON.parse(row.value) : null
}
function saveStoredConfig(value) {
  database
    .prepare("INSERT INTO settings(key, value) VALUES('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(encryptConfig(value)))
}
try {
  const storedConfig = readStoredConfig()
  if (storedConfig) {
    config = decryptConfigWithFallback(storedConfig)
  } else {
    let rawConfig
    try {
      rawConfig = JSON.parse(readFileSync(legacyConfigPath, "utf8"))
      config = decryptConfigWithFallback(rawConfig)
      saveStoredConfig(config)
      log(`migrated config from ${legacyConfigPath} to ${dbPath}`)
    } catch (err) {
      if (err.code !== "ENOENT") throw err
      // No config yet: start from the example (shape + {env:...} keys) or scratch.
      const example = join(here, "config.example.json")
      config = existsSync(example) ? JSON.parse(readFileSync(example, "utf8")) : {}
      saveStoredConfig(config)
      log(`no config at ${legacyConfigPath}; initialized SQLite storage at ${dbPath} from ${existsSync(example) ? "config.example.json" : "scratch"}`)
    }
  }
} catch (err) {
  database.close()
  throw err
}
let PORT, AUTH, LIMIT_COOLDOWN_MS, ERROR_COOLDOWN_MS, HEADER_TIMEOUT_MS
let chains = new Map()

const indexPath = join(here, "public", "index.html")
const readIndexHtml = () => (existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "")
const imageSkillSourcePath = join(here, "skills", "image-generation", "SKILL.md")
const imageSkillTargetPath = () => join(process.env.PP_OPENCODE_SKILLS_DIR ?? join(homedir(), ".config", "opencode", "skills"), "image-generation", "SKILL.md")
const readImageSkill = () => readFileSync(imageSkillSourcePath, "utf8")
function imageSkillStatus() {
  const path = imageSkillTargetPath()
  let installed = false
  let same = false
  try {
    installed = existsSync(path)
    same = installed && readFileSync(path, "utf8") === readImageSkill()
  } catch {
    installed = false
  }
  return { path, installed, same }
}

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
const expandHome = (path) => (typeof path === "string" && path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)
function resolveOpencodeConfigPath() {
  if (config.opencodeConfig) return expandHome(config.opencodeConfig)
  const dir = join(homedir(), ".config", "opencode")
  // OpenCode installations use both names. Prefer the file that already
  // exists; otherwise create the JSON file used by current installations.
  return [join(dir, "opencode.json"), join(dir, "opencode.jsonc")].find(existsSync) ?? join(dir, "opencode.json")
}
function defaultOpencodeConfigSetting() {
  const path = resolveOpencodeConfigPath()
  const dir = join(homedir(), ".config", "opencode")
  if (path === join(dir, "opencode.jsonc")) return "~/.config/opencode/opencode.jsonc"
  return "~/.config/opencode/opencode.json"
}
function providerImageModel(provider, id) {
  const info = provider?.modelInfo?.[id] ?? {}
  const endpoints = Array.isArray(info.endpoints) ? info.endpoints : []
  return info.image === true || String(info.type ?? "").toLowerCase() === "image" || endpoints.some((endpoint) => /images\/(generations|tasks)/i.test(String(endpoint))) || /image/i.test(String(id))
}
function directModelIds(provider, definition) {
  const all = definition?.all === true
  const ids = all ? provider?.models ?? [] : definition?.models ?? []
  return [...new Set(all ? ids.filter((id) => !providerImageModel(provider, id)) : ids)]
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
  // Direct OpenCode models are stored separately from failover chains. They
  // still use the same runtime path: one selected provider/model becomes a
  // one-step chain exposed as "provider/model".
  for (const [provider, def] of Object.entries(c.opencodeModels ?? {})) {
    const p = c.providers?.[provider]
    if (!p?.baseURL) continue
    for (const model of directModelIds(p, def)) {
      const exposed = `${provider}/${model}`
      if (next.has(exposed)) continue // an explicitly configured chain wins
      next.set(exposed, [
        {
          name: provider,
          baseURL: String(p.baseURL).replace(/\/+$/, ""),
          model,
          apiKey: subst(p.apiKey ?? ""),
          headers: Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k, subst(v)])),
        },
      ])
    }
  }
  config = c
  chains = next
  PORT = c.port ?? 8787
  AUTH = c.authToken
  LIMIT_COOLDOWN_MS = (c.limitCooldownSec ?? 300) * 1000 // 429/403/402: block provider 5 min then try again
  ERROR_COOLDOWN_MS = (c.errorCooldownSec ?? 30) * 1000 // 5xx/network: transient
  // This is deliberately a header-only timeout. Once fetch() resolves, the
  // upstream body is streamed without a wall-clock/read timeout: large
  // contexts can spend a minute or more in inference before their first byte.
  HEADER_TIMEOUT_MS = (c.headerTimeoutSec ?? 120) * 1000 // abort only if no response headers arrive in time
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

// Usage counters for the GUI dashboard. Daily snapshots are kept locally for seven calendar days
// in SQLite, separately from the config row so usage history never contains provider credentials.
const USAGE_RETENTION_DAYS = 7
const usageScalarKeys = ["requests", "ok", "failed", "skipped", "failovers", "tokensIn", "tokensOut", "imagesGenerated"]
const MODEL_ROWS_VERSION = 2
const emptyUsage = () => ({ since: Date.now(), requests: 0, ok: 0, failed: 0, skipped: 0, failovers: 0, tokensIn: 0, tokensOut: 0, imagesGenerated: 0, modelsVersion: MODEL_ROWS_VERSION, hours: {}, images: {}, providers: {}, models: {}, sessions: {}, recentImages: [], lastImageModel: null, lastEditImageModel: null })
// Hour bucket "HH" of the local day, for the by-hour charts.
const hourKey = () => String(new Date().getHours()).padStart(2, "0")
const hourStat = () => (usage.hours[hourKey()] ??= { requests: 0, ok: 0, failed: 0, tokensIn: 0, tokensOut: 0 })
const cloneData = (value) => JSON.parse(JSON.stringify(value))
const localDayKey = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}
const usageDayKeys = (today = localDayKey()) => {
  const keys = []
  const date = new Date(`${today}T12:00:00`)
  for (let i = 0; i < USAGE_RETENTION_DAYS; i++) {
    const next = new Date(date)
    next.setDate(date.getDate() - i)
    keys.push(localDayKey(next))
  }
  return keys
}
function normalizeUsageSnapshot(value) {
  const out = emptyUsage()
  for (const key of usageScalarKeys) out[key] = Math.max(0, Number(value?.[key]) || 0)
  out.hours = value?.hours && typeof value.hours === "object" ? cloneData(value.hours) : {}
  out.images = value?.images && typeof value.images === "object" ? cloneData(value.images) : {}
  out.providers = value?.providers && typeof value.providers === "object" ? cloneData(value.providers) : {}
  out.models = value?.models && typeof value.models === "object" ? cloneData(value.models) : {}
  out.sessions = value?.sessions && typeof value.sessions === "object" ? cloneData(value.sessions) : {}
  // Snapshots written before provider/model keys may hold chain aliases, which a
  // name check cannot detect (a chain may contain "/"). The version flag drops
  // them once; rows rebuild from live traffic.
  if ((Number(value?.modelsVersion) || 0) < MODEL_ROWS_VERSION) out.models = {}
  out.modelsVersion = MODEL_ROWS_VERSION
  out.recentImages = Array.isArray(value?.recentImages) ? cloneData(value.recentImages).slice(-30) : []
  out.lastImageModel = value?.lastImageModel && typeof value.lastImageModel === "object" ? cloneData(value.lastImageModel) : null
  out.lastEditImageModel = value?.lastEditImageModel && typeof value.lastEditImageModel === "object" ? cloneData(value.lastEditImageModel) : null
  return out
}
const usageHistory = new Map()
let usageDay = localDayKey()
let usage = emptyUsage()
function usageSnapshot(value = usage) {
  const out = normalizeUsageSnapshot(value)
  delete out.since
  return out
}
function loadUsageHistory() {
  try {
    const count = Number(database.prepare("SELECT COUNT(*) AS count FROM usage_days").get()?.count ?? 0)
    if (count === 0) {
      try {
        const stored = JSON.parse(readFileSync(legacyStatsPath, "utf8"))
        const days = stored?.days && typeof stored.days === "object" ? stored.days : {}
        const insert = database.prepare("INSERT OR IGNORE INTO usage_days(day, payload) VALUES(?, ?)")
        for (const [date, snapshot] of Object.entries(days)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) insert.run(date, JSON.stringify(normalizeUsageSnapshot(snapshot)))
        }
        if (Object.keys(days).length) log(`migrated usage history from ${legacyStatsPath} to ${dbPath}`)
      } catch (err) {
        if (err.code !== "ENOENT") throw err
      }
    }
    const rows = database.prepare("SELECT day, payload FROM usage_days").all()
    for (const row of rows) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(row.day)) usageHistory.set(row.day, normalizeUsageSnapshot(JSON.parse(row.payload)))
    }
  } catch (err) {
    log(`usage: не удалось прочитать историю SQLite ${dbPath}: ${err.message}`)
  }
  usageDay = localDayKey()
  usage = { ...normalizeUsageSnapshot(usageHistory.get(usageDay)), since: Date.now() }
}
function rollUsageDay() {
  const today = localDayKey()
  if (today === usageDay) return
  usageHistory.set(usageDay, usageSnapshot())
  usageDay = today
  usage = emptyUsage()
}
function pruneUsageHistory() {
  const keep = new Set(usageDayKeys())
  for (const date of usageHistory.keys()) if (!keep.has(date)) usageHistory.delete(date)
}
let lastUsageWrite = ""
function persistUsage() {
  rollUsageDay()
  usageHistory.set(usageDay, usageSnapshot())
  pruneUsageHistory()
  // The writer ticks every second; skip SQLite when no traffic changed it.
  const payloads = [...usageHistory].map(([date, snapshot]) => [date, JSON.stringify(snapshot)])
  const signature = payloads.map(([date, payload]) => `${date}\u0000${payload}`).join("\u0001")
  if (signature !== lastUsageWrite) {
    try {
      const insert = database.prepare("INSERT INTO usage_days(day, payload) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET payload = excluded.payload")
      const remove = database.prepare("DELETE FROM usage_days WHERE day = ?")
      const keep = new Set(payloads.map(([date]) => date))
      for (const [date, payload] of payloads) insert.run(date, payload)
      for (const row of database.prepare("SELECT day FROM usage_days").all()) if (!keep.has(row.day)) remove.run(row.day)
      lastUsageWrite = signature
    } catch (err) {
      log(`usage: не удалось сохранить историю SQLite ${dbPath}: ${err.message}`)
    }
  }
  persistLifetime()
}
function usageHistoryView() {
  rollUsageDay()
  const today = usageDay
  return usageDayKeys(today).map((date) => ({ date, ...usageSnapshot(date === today ? usage : usageHistory.get(date) ?? emptyUsage()) }))
}
// Totals that outlive the seven-day window. The history is pruned, so summing
// it cannot answer "how much have I spent in total".
let lifetimeTokens = { tokensIn: 0, tokensOut: 0, requests: 0 }
try {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'lifetimeTokens'").get()
  if (row?.value) lifetimeTokens = { ...lifetimeTokens, ...JSON.parse(row.value) }
} catch (err) {
  log(`usage: не удалось прочитать lifetime-токены: ${err.message}`)
}
function persistLifetime() {
  try {
    database
      .prepare("INSERT INTO settings(key, value) VALUES('lifetimeTokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(lifetimeTokens))
  } catch (err) {
    log(`usage: не удалось сохранить lifetime-токены: ${err.message}`)
  }
}
function addLifetime(tokensIn = 0, tokensOut = 0) {
  lifetimeTokens.tokensIn += tokensIn
  lifetimeTokens.tokensOut += tokensOut
  lifetimeTokens.requests += 1
}
loadUsageHistory()
const statP = (name) => (usage.providers[name] ??= { requests: 0, ok: 0, limits: 0, errors: 0, tokensIn: 0, tokensOut: 0 })
// Keyed by the real upstream model, not the chain alias: a chain is just a
// name, and two chains on one upstream would otherwise double count it.
const statM = (up) => (usage.models[`${up.name}/${up.model}`] ??= { requests: 0, ok: 0, limits: 0, errors: 0, failovers: 0, tokensIn: 0, tokensOut: 0 })
// Best-effort session titles. Accounting never reads the harness files: this
// only labels the rows with the name the user already sees in the harness.
// Cached for a minute so the 3-second poll does not reopen the database.
let sessionTitleCache = { at: 0, titles: {} }
function sessionTitles() {
  const now = Date.now()
  if (now - sessionTitleCache.at < 60_000) return sessionTitleCache.titles
  const titles = {}
  const candidates = [
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db"),
    join(homedir(), ".local", "share", "opencode", "opencode.db"),
  ]
  for (const path of new Set(candidates)) {
    if (!existsSync(path)) continue
    try {
      const db = new DatabaseSync(path, { readOnly: true })
      for (const table of ["session_v2", "session"]) {
        try {
          for (const row of db.prepare(`SELECT id, title FROM ${table}`).all()) {
            if (String(row.title ?? "").trim()) titles[row.id] ??= row.title
          }
        } catch { /* the other table schema */ }
      }
      db.close()
    } catch { /* unreadable database: fall back to ids */ }
    if (Object.keys(titles).length) break
  }
  sessionTitleCache = { at: now, titles }
  return titles
}

// One harness session, keyed by the id it sends in x-opencode-session-id.
// Nothing is read from the harness's files: only proxied traffic is counted.
const statS = (session) => {
  const key = typeof session === "string" ? session.trim() : ""
  if (!key) return null
  const row = (usage.sessions[key] ??= { requests: 0, ok: 0, limits: 0, errors: 0, tokensIn: 0, tokensOut: 0, firstSeen: Date.now(), lastSeen: Date.now() })
  row.lastSeen = Date.now()
  return row
}
const statI = (provider, model) => (usage.images[`${provider}/${model}`] ??= { provider, model, requests: 0, ok: 0, errors: 0, lastStatus: 0, lastUsedAt: null, lastEditAt: null, lastMode: null })
const imageTasks = new Map() // provider/task_id -> { imageKey, historyIndex }
const imageModelIsEdit = (body) => typeof body?.image === "string" && body.image.trim().length > 0
function isConfiguredImageModel(providerName, model) {
  const p = config.providers?.[providerName]
  const info = p?.modelInfo?.[model] ?? {}
  const endpoints = collectStrings(info.endpoints ?? [])
  return info.image === true || String(info.type ?? "").toLowerCase() === "image" || endpoints.some((x) => /images\/(generations|tasks)/i.test(x)) || /image/i.test(model)
}
function imageModelSuggestions(exclude = "") {
  const suggestions = []
  for (const [providerName, provider] of Object.entries(config.providers ?? {})) {
    const ids = [...new Set(provider.models ?? [])]
    for (const model of ids) {
      if (!isConfiguredImageModel(providerName, model) || `${providerName}/${model}` === exclude) continue
      suggestions.push(`${providerName}/${model}`)
    }
  }
  return suggestions.slice(0, 8)
}
function recordImageRequest(provider, model, body, status = "pending", endpoint = "") {
  const now = new Date().toISOString()
  const mode = imageModelIsEdit(body) ? "edit" : "generate"
  const key = `${provider}/${model}`
  const stat = statI(provider, model)
  stat.lastUsedAt = now
  stat.lastMode = mode
  if (mode === "edit") stat.lastEditAt = now
  const entry = { provider, model, mode, status, endpoint, at: now }
  usage.recentImages = [...(usage.recentImages ?? []).filter((item) => !(item.provider === provider && item.model === model && item.status === "pending")), entry].slice(-30)
  usage.lastImageModel = { provider, model, mode, at: now }
  if (mode === "edit") usage.lastEditImageModel = { provider, model, at: now }
  return { key, historyIndex: usage.recentImages.length - 1 }
}
function finishImageRequest(ref, status, endpoint = "") {
  if (!ref) return
  const item = [...(usage.recentImages ?? [])].reverse().find((candidate) => candidate.provider + "/" + candidate.model === ref.key && candidate.status === "pending")
  if (item) {
    item.status = status
    if (endpoint) item.endpoint = endpoint
  }
}

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
    if (!s) continue // no session id on this request
    s.tokensIn += tin
    s.tokensOut += tout
  }
  const hour = hourStat()
  hour.tokensIn += tin
  hour.tokensOut += tout
  addLifetime(tin, tout)
}

// Normalize upstream SSE before handing it to OpenCode. Some OpenAI-compatible
// gateways add `event:`/comment frames, mix LF and CRLF, or emit `data: null`
// keepalives. OpenCode's strict chat decoder expects only object JSON events
// (plus [DONE]); passing those extra frames through causes an invalid stream
// event and aborts an otherwise valid response.
async function* normalizeSse(body, exposed, upstream) {
  const decoder = new TextDecoder()
  let buffer = ""
  let tail = ""
  const toolIndexes = new Map()
  const finishReasons = new Map()
  const toolChoices = new Set()
  const choiceIndexes = new Set()
  let lastMeta = {}
  let doneSeen = false
  // Some gateways send [DONE] without a terminal choice. Supply one so
  // strict OpenAI-compatible clients always see finish_reason.
  const terminal = () => {
    const pending = [...choiceIndexes].filter((index) => !finishReasons.has(index))
    const indexes = pending.length ? pending : choiceIndexes.size ? [] : [0]
    if (!indexes.length) return ""
    const choices = indexes.map((index) => ({
      index,
      delta: {},
      finish_reason: toolChoices.has(index) ? "tool_calls" : "stop",
    }))
    for (const choice of choices) finishReasons.set(choice.index, choice.finish_reason)
    return `data: ${JSON.stringify({
      ...(lastMeta.id ? { id: lastMeta.id } : {}),
      object: lastMeta.object ?? "chat.completion.chunk",
      ...(lastMeta.created ? { created: lastMeta.created } : {}),
      model: lastMeta.model ?? upstream.model,
      choices,
    })}\n\n`
  }
  const emit = (rawEvent) => {
    const data = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
    if (!data.length) return ""
    const payload = data.join("\n").trim()
    if (!payload) return ""
    if (payload === "[DONE]") {
      doneSeen = true
      return `${terminal()}data: [DONE]\n\n`
    }
    try {
      const parsed = JSON.parse(payload)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        log(`${exposed} → ${upstream.name}/${upstream.model}: пропущен не-объектный SSE кадр`)
        return ""
      }
      if (!Array.isArray(parsed.choices)) {
        if (parsed.usage && typeof parsed.usage === "object") return `data: ${JSON.stringify(parsed)}\n\n`
        // Keep-alive or metadata ping: normal, not worth a log line per frame.
        return ""
      }
      if (!parsed.choices.length && !parsed.usage) {
        log(`${exposed} → ${upstream.name}/${upstream.model}: пропущен пустой SSE кадр`)
        return ""
      }
      lastMeta = {
        id: parsed.id,
        object: parsed.object,
        created: parsed.created,
        model: parsed.model,
      }
      parsed.choices = parsed.choices.map((choice, choicePosition) => {
        const normalized = { ...choice, index: Number.isFinite(choice?.index) ? choice.index : choicePosition }
        choiceIndexes.add(normalized.index)
        if (normalized.finish_reason != null) finishReasons.set(normalized.index, normalized.finish_reason)
        else normalized.finish_reason = null
        if (choice?.delta && typeof choice.delta === "object" && !Array.isArray(choice.delta)) {
          normalized.delta = { ...choice.delta }
          if (Array.isArray(choice.delta.tool_calls)) {
            normalized.delta.tool_calls = choice.delta.tool_calls.map((call, callPosition) => {
              toolChoices.add(normalized.index)
              const key = `${normalized.index}:${call?.id ?? callPosition}`
              let index
              if (Number.isFinite(call?.index)) index = call.index
              // A first fragment opens a call by id; argument fragments carry
              // neither id nor index and continue the call that is still open.
              // Using the array position for either merged separate calls into
              // slot 0, so clients saw duplicated tool calls.
              else if (call?.id) index = toolIndexes.get(key) ?? (toolIndexes.get(`${normalized.index}:@open`) ?? -1) + 1
              else index = toolIndexes.get(`${normalized.index}:@open`) ?? callPosition
              toolIndexes.set(key, index)
              toolIndexes.set(`${normalized.index}:@open`, index)
              const next = { ...call, index }
              if (!next.type && next.function) next.type = "function"
              return next
            })
          }
        } else if (choice?.delta == null) {
          normalized.delta = {}
        }
        return normalized
      })
      if (parsed.usage === null) delete parsed.usage
      return `data: ${JSON.stringify(parsed)}\n\n`
    } catch {
      // Preserve malformed object-looking payloads so OpenCode still reports
      // a useful provider error instead of silently hiding a real bad frame.
      return `${data.map((line) => `data: ${line}`).join("\n")}\n\n`
    }
  }
  const drain = function* (flush = false) {
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const events = buffer.split("\n\n")
    buffer = flush ? "" : events.pop() ?? ""
    for (const event of events) {
      const normalized = emit(event)
      if (normalized) yield normalized
    }
    if (flush && buffer) {
      const normalized = emit(buffer)
      if (normalized) yield normalized
      buffer = ""
    }
  }
  for await (const chunk of Readable.fromWeb(body)) {
    buffer += tail + decoder.decode(chunk, { stream: true })
    tail = ""
    // Keep a trailing CR until the next chunk so a split CRLF remains one line ending.
    if (buffer.endsWith("\r")) {
      buffer = buffer.slice(0, -1)
      tail = "\r"
    }
    yield* drain()
  }
  buffer += tail + decoder.decode()
  yield* drain(true)
  if (!doneSeen) {
    const incomplete = !choiceIndexes.size || [...choiceIndexes].some((index) => !finishReasons.has(index))
    if (incomplete) {
      const message = "upstream SSE stream ended before [DONE]"
      log(`${exposed} → ошибка потока ${upstream.name}/${upstream.model}: ${message}`)
      yield streamErrorSse(message)
    } else {
      const final = terminal()
      if (final) yield final
      yield "data: [DONE]\n\n"
    }
  }
}

function streamErrorSse(message) {
  return `data: ${JSON.stringify({ error: { message, type: "proxy_stream_error" } })}\n\ndata: [DONE]\n\n`
}

// A few gateways ignore `stream: true` and return a regular completion. Turn
// that response into a minimal OpenAI-compatible stream instead of handing
// JSON to OpenCode's SSE decoder.
function completionToSse(text, upstream) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.choices)) return null
  const meta = {
    ...(parsed.id ? { id: parsed.id } : {}),
    object: "chat.completion.chunk",
    ...(parsed.created ? { created: parsed.created } : {}),
    model: parsed.model ?? upstream.model,
  }
  const choices = parsed.choices.length ? parsed.choices : [{ index: 0, message: {} }]
  const content = choices.map((choice, position) => {
    const message = choice?.message && typeof choice.message === "object" ? choice.message : {}
    const delta = {}
    if (message.role) delta.role = message.role
    if (message.content !== undefined) delta.content = message.content
    if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls
    if (message.function_call && typeof message.function_call === "object") delta.function_call = message.function_call
    return { index: Number.isFinite(choice?.index) ? choice.index : position, delta, finish_reason: null }
  })
  const terminal = choices.map((choice, position) => ({
    index: Number.isFinite(choice?.index) ? choice.index : position,
    delta: {},
    finish_reason: choice?.finish_reason ?? "stop",
  }))
  const usage = parsed.usage && typeof parsed.usage === "object" ? { usage: parsed.usage } : {}
  return `data: ${JSON.stringify({ ...meta, choices: content })}\n\n` +
    `data: ${JSON.stringify({ ...meta, ...usage, choices: terminal })}\n\n` +
    "data: [DONE]\n\n"
}

// Never fail over ordinary client errors (400/401/404/etc.). A chain may
// switch only for these known quota/access/timeout/server failures.
const FAILOVER = (status) => status === 402 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599)

// opencode не умеет сам брать список моделей у кастомного провайдера (GET /v1/models он не зовёт),
// поэтому карта моделей должна лежать в его конфиге. Синхронизируем её отсюда: провайдер — источник истины.
const modelContextLength = (provider, model) => {
  const info = config.providers?.[provider]?.modelInfo?.[model] ?? {}
  const value = Number(info.contextLength)
  const providerValue = Number(info.providerContextLength)
  if (!Number.isSafeInteger(value) || value <= 0) return Number.isSafeInteger(providerValue) && providerValue > 0 ? providerValue : null
  return Number.isSafeInteger(providerValue) && providerValue > 0 ? Math.min(value, providerValue) : value
}
const chainContextLength = (chain) => {
  const contexts = chain.map((upstream) => modelContextLength(upstream.name, upstream.model)).filter(Boolean)
  return contexts.length ? Math.min(...contexts) : null
}
function applyModelContext(entry, context) {
  if (!context || !entry || typeof entry !== "object") return
  entry.limit = { ...(entry.limit && typeof entry.limit === "object" ? entry.limit : {}), context }
}
function syncOpencode() {
  const path = resolveOpencodeConfigPath()
  const id = config.opencodeProvider ?? "provider-proxy"
  const enabled = config.integrations?.opencode?.enabled !== false
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
  const enabledEntries = enabled ? Object.entries(config.models ?? {}).filter(([, def]) => def?.enabled !== false) : []
  const chainNames = new Set(enabledEntries.map(([name]) => name))
  for (const [name, def] of enabledEntries) {
    const chain = chains.get(name) ?? []
    const old = prev[name] ?? {}
    // Keep the OpenCode catalog self-describing: the suffix shows that this
    // entry is backed by the proxy and how many fallback models it contains.
    p.models[name] = { name: `${name} (proxy, x${chain.length})` }
    for (const [k, v] of Object.entries(old)) if (k !== "name") p.models[name][k] = v
    applyModelContext(p.models[name], chainContextLength(chain))
  }
  const directEntries = []
  for (const [provider, def] of enabled ? Object.entries(config.opencodeModels ?? {}) : []) {
    if (def?.enabled === false || !config.providers?.[provider]?.baseURL) continue
    for (const model of directModelIds(config.providers?.[provider], def)) {
      const name = `${provider}/${model}`
      if (chainNames.has(name)) continue
      const old = prev[name] ?? {}
      p.models[name] = { name: `${name} (config)` }
      for (const [k, v] of Object.entries(old)) if (k !== "name") p.models[name][k] = v
      applyModelContext(p.models[name], modelContextLength(provider, model))
      directEntries.push(name)
    }
  }
  // Пишем НА МЕСТЕ (тот же inode): opencode следит за файлом и перечитывает его только так.
  // rename() менял inode — opencode не подхватывал новые модели. Бэкап рядом, чтобы откатить руками.
  writeFileSync(path + ".bak", raw)
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
  log(`opencode: ${enabled ? enabledEntries.length + directEntries.length : 0} моделей провайдера «${id}» записаны в ${path}${enabled ? "" : " (интеграция выключена)"}`)
  return true
}

async function readBody(req) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw
}

// A few OpenAI-compatible gateways validate tool calls more strictly than
// OpenCode's client. In particular, function.arguments must be a JSON string
// even when a previous provider returned it as an already-parsed object.
// Normalize only those fields before forwarding; the rest of the request is
// kept untouched for provider-specific options.
function normalizeChatPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const body = cloneData(value)
  if (!Array.isArray(body.messages)) return body
  body.messages = body.messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message
    const next = { ...message }
    if (Array.isArray(next.tool_calls)) {
      next.tool_calls = next.tool_calls.map((call) => {
        if (!call || typeof call !== "object" || Array.isArray(call)) return call
        const normalized = { ...call }
        if (normalized.function && typeof normalized.function === "object" && !Array.isArray(normalized.function)) {
          normalized.function = { ...normalized.function }
          if (normalized.function.arguments !== undefined && typeof normalized.function.arguments !== "string") {
            normalized.function.arguments = JSON.stringify(normalized.function.arguments)
          }
        }
        return normalized
      })
    }
    if (next.function_call && typeof next.function_call === "object" && !Array.isArray(next.function_call)) {
      next.function_call = { ...next.function_call }
      if (next.function_call.arguments !== undefined && typeof next.function_call.arguments !== "string") {
        next.function_call.arguments = JSON.stringify(next.function_call.arguments)
      }
    }
    if (next.role === "tool" && next.content !== undefined && typeof next.content !== "string") {
      next.content = JSON.stringify(next.content)
    }
    return next
  })
  return body
}

function upstreamErrorMessage(text) {
  try {
    const data = JSON.parse(text)
    return data?.error?.message ?? data?.message ?? data?.detail ?? data?.error ?? ""
  } catch {
    return String(text).trim().replace(/\s+/g, " ").slice(0, 240)
  }
}

let listenPort = null
let lastPing = null // last /api/ping from the GUI tab; null until the GUI is first opened
let lastV1 = 0 // last /v1/* request time
let active = 0 // in-flight proxied chat requests
let shutdownRequested = false

function stopApplication() {
  if (shutdownRequested) return
  shutdownRequested = true
  persistUsage()
  setTimeout(() => {
    try {
      server.closeAllConnections?.()
    } catch {
      /* best effort: the forced exit below is the final fallback */
    }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }, 100).unref()
}
const usagePersistTimer = setInterval(persistUsage, 1000)
usagePersistTimer.unref()
process.on("exit", () => persistUsage())
process.on("SIGTERM", () => {
  persistUsage()
  process.exit(0)
})
process.on("SIGINT", () => {
  persistUsage()
  process.exit(0)
})

const server = http.createServer(async (req, res) => {
  res.on("error", () => {}) // a client disconnecting mid-stream must not crash the proxy
  try {
    // The GUI page itself is public (localhost); its /api calls carry the token when authToken is set.
    const pathname = String(req.url ?? "/").split("?", 1)[0]
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      // Read the page for every request so a long-running proxy serves a freshly edited GUI
      // without requiring a server restart. no-store also avoids a stale browser copy.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" })
      return res.end(readIndexHtml())
    }

    // Liveness heartbeat from the GUI tab; exempt from authToken so the tab can always keep us alive.
    if (req.method === "GET" && req.url === "/api/ping") {
      lastPing = Date.now()
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, apiVersion: API_VERSION }))
    }

    if (AUTH && req.headers.authorization !== `Bearer ${AUTH}`) {
      log(`401 ${req.method} ${req.url} — нет/неверный токен (authToken в SQLite)`)
      res.writeHead(401, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: "bad proxy token" } }))
    }

    if (req.method === "POST" && req.url === "/api/shutdown") {
      log("shutdown requested from GUI")
      res.writeHead(200, { "content-type": "application/json", "connection": "close" })
      res.end(JSON.stringify({ ok: true, stopping: true }))
      stopApplication()
      return
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
      const session = String(req.headers["x-opencode-session-id"] ?? "").trim() || null
      return await proxyChat(body, res, session)
    }

    // ---- GUI API ----

    if (req.url === "/api/config" && req.method === "GET") {
      const exposed = publicConfig(config)
      exposed.appVersion = APP_VERSION
      if (!config.opencodeConfig) exposed.opencodeConfig = defaultOpencodeConfigSetting()
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(exposed))
    }

    if (pathname === "/api/config/export" && req.method === "GET") {
      const query = new URL(req.url, "http://127.0.0.1").searchParams
      const included = (name) => query.has(name) ? query.get(name) !== "0" && query.get(name) !== "false" : true
      const exported = exportConfig(config, { keys: included("keys"), chains: included("chains"), models: included("models") })
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="provider-proxy-config.json"',
      })
      return res.end(JSON.stringify(exported, null, 2) + "\n")
    }

    if (req.url === "/api/config/import" && req.method === "POST") {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "invalid JSON" }))
      }
      const imported = body?.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : body
      const validationError = validateImportedConfig(imported)
      if (validationError) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: validationError }))
      }
      const nextConfig = mergeImportedConfig(imported, config)
      applyConfig(nextConfig)
      saveStoredConfig(nextConfig)
      log(`config imported: ${Object.keys(nextConfig.providers ?? {}).length} providers, ${chains.size} models`)
      const opencodeSynced = syncOpencode()
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, opencodeSynced, restartRequired: (nextConfig.port ?? 8787) !== listenPort }))
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
      const nextConfig = mergeConfigSecrets(body, config)
      applyConfig(nextConfig)
      saveStoredConfig(nextConfig)
      log(`config updated via GUI: ${Object.keys(nextConfig.providers ?? {}).length} providers, ${chains.size} models`)
      const opencodeSynced = syncOpencode() // карта моделей в конфиге opencode — чтобы новые модели были видны сразу
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, opencodeSynced, restartRequired: (nextConfig.port ?? 8787) !== listenPort }))
    }

    if (req.url === "/api/skills/image-generation" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(imageSkillStatus()))
    }

    if (req.url === "/api/skills/image-generation" && req.method === "POST") {
      let body = {}
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        /* empty body means install without overwriting a custom skill */
      }
      const path = imageSkillTargetPath()
      const content = readImageSkill()
      const current = imageSkillStatus()
      if (current.installed && !current.same && body.overwrite !== true) {
        res.writeHead(409, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "skill already exists and differs from the bundled version", ...current }))
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      log(`skill: image-generation ${current.same ? "already installed" : current.installed ? "updated" : "installed"} at ${path}`)
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, ...imageSkillStatus() }))
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
        const storedProvider = body.provider ? config.providers?.[body.provider] : null
        const baseURL = storedProvider?.baseURL ?? body.baseURL ?? ""
        const apiKey = storedProvider?.apiKey ?? body.apiKey ?? ""
        const providerHeaders = storedProvider?.headers ?? body.headers ?? {}
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 10_000)
        const resp = await fetch(`${String(baseURL).replace(/\/+$/, "")}/models`, {
          headers: { authorization: `Bearer ${subst(apiKey)}`, ...providerHeaders },
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        const data = await resp.json().catch(() => ({}))
        const rawItems = data.data ?? data.models ?? []
        const items = Array.isArray(rawItems)
          ? rawItems
          : Object.entries(rawItems).map(([id, meta]) => ({ id, ...(meta && typeof meta === "object" ? meta : {}) }))
        const ids = []
        const details = {}
        for (const item of items) {
          const id = item?.id ?? item?.name ?? item
          if (typeof id !== "string") continue
          ids.push(id)
          const contextLength = Number(
            item?.context_length ?? item?.contextLength ?? item?.context_window ?? item?.max_context_length ?? item?.maxContextLength,
          )
          const type = typeof item?.type === "string" ? item.type : ""
          const endpoints = collectStrings(item?.endpoints ?? item?.endpoint ?? item?.supported_endpoints ?? [])
          const image = type.toLowerCase() === "image" || endpoints.some((endpoint) => /images\/(generations|tasks)/i.test(endpoint)) || `${id} ${item?.name ?? ""}`.toLowerCase().includes("image")
          if ((Number.isFinite(contextLength) && contextLength > 0) || type || endpoints.length || image) {
            details[id] = {
              ...(Number.isFinite(contextLength) && contextLength > 0 ? { contextLength } : {}),
              ...(type ? { type } : {}),
              ...(endpoints.length ? { endpoints: [...new Set(endpoints)] } : {}),
              ...(image ? { image: true } : {}),
            }
          }
        }
        res.writeHead(resp.ok ? 200 : 502, { "content-type": "application/json" })
        return res.end(JSON.stringify(resp.ok ? { models: ids, details } : { error: `HTTP ${resp.status}` }))
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: String(err.cause?.code ?? err.message) }))
      }
    }

    // Image generation for OpenAI-style clients: POST /v1/images/generations takes the model
    // as "provider/model" (e.g. aquadevs/agnes-image) and returns a task (202), since the
    // provider's image API is asynchronous.
    if (pathname === "/v1/images/generations" && req.method === "POST") {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        body = {}
      }
      const [providerId, ...rest] = String(body.model ?? "").split("/")
      const provider = config.providers?.[providerId]
      const model = rest.join("/")
      if (!provider?.baseURL || !model || typeof body.prompt !== "string" || !body.prompt.trim()) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "model must be provider/model (e.g. aquadevs/agnes-image) and prompt is required" } }))
      }
      const payload = { model, prompt: body.prompt.trim() }
      for (const key of ["ratio", "size", "image"]) if (typeof body[key] === "string" && body[key].trim()) payload[key] = body[key].trim()
      const requestBytes = Buffer.byteLength(JSON.stringify(payload))
      log(`image request ${providerId}/${model} via /v1/images/generations: ${requestBytes} bytes, mode=${imageModelIsEdit(body) ? "edit" : "generate"}`)
      try {
        const response = await fetch(`${String(provider.baseURL).replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${subst(provider.apiKey ?? "")}`, ...(provider.headers ?? {}) },
          body: JSON.stringify(payload),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          log(`image upstream error ${providerId}/${model} /v1/images/generations: HTTP ${response.status}, ${requestBytes} bytes: ${data?.error?.message ?? data?.detail ?? data?.error ?? "upstream error"}`)
          res.writeHead(502, { "content-type": "application/json" })
          return res.end(JSON.stringify({ error: { message: data?.error?.message ?? data?.detail ?? `HTTP ${response.status}` } }))
        }
        res.writeHead(202, { "content-type": "application/json" })
        return res.end(JSON.stringify(data))
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: String(err.cause?.code ?? err.message) } }))
      }
    }

    const imageTaskLookup = pathname.match(/^\/v1\/images\/tasks\/([^/]+)$/)
    if (imageTaskLookup && req.method === "GET") {
      const providerId = String(req.headers["x-image-provider"] ?? "")
      const provider = config.providers?.[providerId]
      if (!provider?.baseURL) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "x-image-provider header is required" } }))
      }
      try {
        const response = await fetch(`${String(provider.baseURL).replace(/\/+$/, "")}/images/tasks/${encodeURIComponent(imageTaskLookup[1])}`, {
          headers: { authorization: `Bearer ${subst(provider.apiKey ?? "")}`, ...(provider.headers ?? {}) },
        })
        const data = await response.json().catch(() => ({}))
        res.writeHead(response.ok ? 200 : 502, { "content-type": "application/json" })
        return res.end(JSON.stringify(response.ok ? data : { error: { message: data?.detail ?? data?.error ?? `HTTP ${response.status}` } }))
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: String(err.cause?.code ?? err.message) } }))
      }
    }

    // Image generation supports both provider contracts exposed in /v1/models:
    // synchronous /images/generations and asynchronous /images/tasks.
    // Keep provider credentials on the proxy so the browser never sees them.
    if (req.url === "/api/image-tasks" && req.method === "POST") {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        body = {}
      }
      const provider = config.providers?.[body.provider]
      if (!provider?.baseURL || typeof body.model !== "string" || typeof body.prompt !== "string" || !body.prompt.trim()) {
        log(`image request ${body.provider ?? "?"}/${body.model ?? "?"} → HTTP 400: provider, model and prompt are required`)
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "provider, model and prompt are required" }))
      }
      rollUsageDay()
      const imageStat = statI(body.provider, body.model)
      imageStat.requests++
      const payload = { model: body.model, prompt: body.prompt.trim() }
      for (const key of ["ratio", "size", "image", "aspect_ratio"]) if (typeof body[key] === "string" && body[key].trim()) payload[key] = body[key].trim()
      const requestBytes = Buffer.byteLength(JSON.stringify(payload))
      const imageRef = recordImageRequest(body.provider, body.model, body, "pending")
      log(`image request ${body.provider}/${body.model}: ${requestBytes} bytes, mode=${imageModelIsEdit(body) ? "edit" : "generate"}, promptChars=${body.prompt.trim().length}${body.image ? `, referenceChars=${String(body.image).length}` : ""}`)
      const endpoints = collectStrings(provider.modelInfo?.[body.model]?.endpoints ?? [])
      const endpointNames = [...new Set(endpoints.map(imageEndpointName).filter(Boolean))]
      const preferredEndpoint = endpointNames[0] ?? "images/tasks"
      const endpointCandidates = preferredEndpoint === "images/generations" ? ["images/generations", "images/tasks"] : ["images/tasks", "images/generations"]
      try {
        let endpoint = endpointCandidates[0]
        let response
        let data
        for (const candidate of endpointCandidates) {
          endpoint = candidate
          response = await fetch(`${String(provider.baseURL).replace(/\/+$/, "")}/${candidate}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${subst(provider.apiKey ?? "")}`, ...(provider.headers ?? {}) },
            body: JSON.stringify(payload),
          })
          data = await response.json().catch(() => ({}))
          if (response.status !== 404 || candidate === endpointCandidates.at(-1)) break
        }
        const resultStatus = response.ok ? 200 : response.status === 404 ? 404 : response.status === 413 ? 413 : 502
        const resultMessage = response.ok ? `image ${endpoint} ${body.provider}/${body.model} → HTTP ${response.status}` : `image ${endpoint} ${body.provider}/${body.model} → HTTP ${response.status}: ${data?.error?.message ?? data?.error ?? data?.detail ?? "upstream error"}`
        log(resultMessage)
        if (!response.ok) log(`image failure details ${body.provider}/${body.model}: requestBytes=${requestBytes}, endpoint=${endpoint}, status=${response.status}, suggested=${imageModelSuggestions(`${body.provider}/${body.model}`).join(",") || "none"}`)
        imageStat.lastStatus = response.status
        if (response.ok && endpoint === "images/generations") {
          imageStat.ok++
          usage.imagesGenerated++
          finishImageRequest(imageRef, "succeeded", endpoint)
        } else if (!response.ok) {
          imageStat.errors++
          finishImageRequest(imageRef, "failed", endpoint)
        }
        if (response.ok && endpoint === "images/tasks") {
          const taskId = data?.task_id ?? data?.taskId ?? data?.id ?? data?.data?.task_id ?? data?.data?.taskId ?? data?.data?.id
          if (taskId) {
            imageTasks.set(`${body.provider}/${taskId}`, { ...imageRef, imageKey: `${body.provider}/${body.model}` })
            // A task whose tab closes before the terminal poll would stay in
            // the map forever; keep only the newest few hundred.
            if (imageTasks.size > 256) imageTasks.delete(imageTasks.keys().next().value)
          }
          else finishImageRequest(imageRef, "succeeded", endpoint)
        }
        res.writeHead(resultStatus, { "content-type": "application/json" })
        const upstreamError = data?.error?.message ?? data?.error ?? data?.detail ?? `HTTP ${response.status}`
        return res.end(JSON.stringify(response.ok ? { ...data, _providerEndpoint: endpoint } : { error: upstreamError, status: response.status, provider: body.provider, model: body.model, endpoint, requestBytes, suggestedModels: imageModelSuggestions(`${body.provider}/${body.model}`) }))
      } catch (err) {
        imageStat.errors++
        imageStat.lastStatus = 502
        finishImageRequest(imageRef, "failed", endpoint)
        log(`image request ${body.provider}/${body.model} → HTTP 502: ${String(err.cause?.code ?? err.message)}; requestBytes=${requestBytes}; suggested=${imageModelSuggestions(`${body.provider}/${body.model}`).join(",") || "none"}`)
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: String(err.cause?.code ?? err.message) }))
      }
    }

    const imageTaskMatch = pathname.match(/^\/api\/image-tasks\/([^/]+)\/([^/]+)$/)
    if (imageTaskMatch && req.method === "GET") {
      const provider = config.providers?.[decodeURIComponent(imageTaskMatch[1])]
      const taskId = decodeURIComponent(imageTaskMatch[2])
      if (!provider?.baseURL || !taskId) {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "provider and taskId are required" }))
      }
      try {
        const response = await fetch(`${String(provider.baseURL).replace(/\/+$/, "")}/images/tasks/${encodeURIComponent(taskId)}`, {
          headers: { authorization: `Bearer ${subst(provider.apiKey ?? "")}`, ...(provider.headers ?? {}) },
        })
        const data = await response.json().catch(() => ({}))
        const imageRef = imageTasks.get(`${imageTaskMatch[1]}/${taskId}`)
        const imageKey = imageRef?.imageKey
        const imageStat = imageKey ? usage.images[imageKey] : null
        const status = String(data?.status ?? data?.result?.status ?? data?.data?.status ?? "").toLowerCase()
        if (imageStat && ["completed", "complete", "success", "succeeded", "done"].includes(status)) {
          imageStat.ok++
          usage.imagesGenerated++
          imageStat.lastStatus = response.status
          finishImageRequest(imageRef, "succeeded", "images/tasks")
          imageTasks.delete(`${imageTaskMatch[1]}/${taskId}`)
        } else if (imageStat && ["failed", "error", "cancelled", "canceled"].includes(status)) {
          imageStat.errors++
          imageStat.lastStatus = response.status
          finishImageRequest(imageRef, "failed", "images/tasks")
          imageTasks.delete(`${imageTaskMatch[1]}/${taskId}`)
        }
        if (!response.ok && imageStat) imageStat.errors++
        log(`image tasks/${taskId} ${imageTaskMatch[1]} → HTTP ${response.status}${status ? ` (${status})` : ""}${!response.ok ? `: ${data?.error?.message ?? data?.error ?? data?.detail ?? "upstream error"}` : ""}`)
        res.writeHead(response.ok ? 200 : 502, { "content-type": "application/json" })
        return res.end(JSON.stringify(response.ok ? data : { error: data?.error ?? `HTTP ${response.status}` }))
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: String(err.cause?.code ?? err.message) }))
      }
    }

    if (req.url === "/api/opencode-sync" && req.method === "POST") {
      const ok = syncOpencode()
      res.writeHead(200, { "content-type": "application/json" })
      const enabled = config.integrations?.opencode?.enabled !== false
      const models = enabled
        ? Object.values(config.models ?? {}).filter((def) => def?.enabled !== false).length + Object.entries(config.opencodeModels ?? {}).reduce((n, [provider, def]) => n + (def?.enabled === false ? 0 : directModelIds(config.providers?.[provider], def).length), 0)
        : 0
      return res.end(JSON.stringify({ ok, enabled, models }))
    }

    if (req.url === "/api/logs" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ lines: logs.filter((line) => !line.includes("gui:")), max: LOG_MAX }))
    }

    if (req.url === "/api/usage" && req.method === "GET") {
      persistUsage()
      const now = Date.now()
      const coolingNow = [...cooldowns]
        .filter(([, until]) => until > now)
        .map(([key, until]) => {
          const [model, upstream] = key.split("|")
          return { model, upstream, until }
        })
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ...usage, cooldowns: coolingNow, uptimeMs: now - usage.since, today: usageDay, retentionDays: USAGE_RETENTION_DAYS, days: usageHistoryView(), lifetimeTokens, sessionTitles: sessionTitles() }))
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
// Do not let Node's generic socket/request timers terminate a long inference
// while the upstream is still producing a valid response. The upstream header
// deadline is controlled separately by headerTimeoutSec above.
server.requestTimeout = 0
server.timeout = 0

// "1m 30s" / "45s" / "5m" — human readable duration for log lines.
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m >= 1 ? `${m}m ${s % 60}s` : `${s}s`
}

async function proxyChat(body, res, session = null) {
  rollUsageDay()
  const exposed = body.model
  const chain = chains.get(exposed)
  if (!chain) {
    res.writeHead(404, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: { message: `unknown model: ${exposed}` } }))
  }

  // If the client (opencode) disconnects, drop the upstream call too.
  active++
  usage.requests++
  hourStat().requests++
  const sStat = statS(session)
  if (sStat) sStat.requests++
  let current = null
  res.on("close", () => {
    active--
    if (!res.writableEnded) current?.abort()
  })

  let lastError = "all upstreams are cooling down"
  let attempted = false
  for (let i = 0; i < chain.length; i++) {
    const up = chain[i]
    const key = `${exposed}|${up.name}|${up.model}` // stable under chain edits from the GUI
    if (cooling(key)) continue
    attempted = true
    const ctrl = new AbortController()
    current = ctrl
    const pStat = statP(up.name)
    pStat.requests++
    const mStat = statM(up)
    mStat.requests++
    const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS)
    try {
      const upstreamBody = normalizeChatPayload({ ...body, model: up.model })
      const resp = await fetch(`${up.baseURL}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${up.apiKey}`, ...up.headers },
        body: JSON.stringify(upstreamBody),
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
        if (resp.status === 429) mStat.limits++
        else mStat.errors++
        if (sStat) {
          if (resp.status === 429) sStat.limits++
          else sStat.errors++
        }
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
          mStat.errors++
          if (sStat) sStat.errors++
          log(
            `${exposed} → свитч: ${up.name}/${up.model} не поддерживает запрос (HTTP 400) на ${fmtDur(ERROR_COOLDOWN_MS)}, пробую следующего`,
          )
          continue
        }
        // A plain 400 is passed through as-is, but it is still an outcome:
        // without this the provider showed one request and no ok/err at all.
        pStat.errors++
        mStat.errors++
        usage.failed++
        hourStat().failed++
        if (sStat) sStat.errors++
        log(`${exposed} → ошибка: ${up.name}/${up.model} (HTTP 400${t.trim() ? `: ${upstreamErrorMessage(t)}` : ""})`)
        res.writeHead(400, { "content-type": resp.headers.get("content-type") ?? "application/json" })
        return res.end(t)
      }

      // Success, or a client error that would repeat on every upstream (401, 404...): pass through untouched.
      log(`${exposed} → ${resp.ok ? "ответ" : "ошибка"}: ${up.name}/${up.model} (HTTP ${resp.status})`)
      const isSse = (resp.headers.get("content-type") ?? "").includes("text/event-stream")
      const streamRequested = body.stream === true
      const headers = Object.fromEntries(resp.headers)
      // undici may hand us a decoded body; stale framing headers would corrupt the passthrough
      delete headers["content-encoding"]
      delete headers["content-length"]
      delete headers["transfer-encoding"]
      delete headers["connection"]
      if (streamRequested && !isSse) {
        headers["content-type"] = "text/event-stream; charset=utf-8"
        headers["cache-control"] = "no-cache"
        log(`${exposed} → ${up.name}/${up.model}: upstream вернул обычный JSON вместо SSE, адаптирую поток`)
      }
      res.writeHead(resp.status, headers)
      // "ok" means the upstream answered successfully. A 401/404 passed straight
      // through is a failed attempt, not a success.
      if (resp.ok) {
        usage.ok++
        hourStat().ok++
        pStat.ok++
        mStat.ok++
        if (sStat) sStat.ok++
      } else {
        usage.failed++
        hourStat().failed++
        pStat.errors++
        mStat.errors++
        if (sStat) sStat.errors++
      }
      if (!resp.body) return res.end()

      // Stream the body through untouched, watching for a usage report on the way (see tally()).
      let tail = ""
      try {
        if (isSse) {
          for await (const event of normalizeSse(resp.body, exposed, up)) {
            tail = (tail + event).slice(-8192) // usage arrives in the final chunk
            if (!res.write(event)) await once(res, "drain")
          }
          res.end()
          // tally happens in finally, also on an interrupted stream
        } else {
          const chunks = []
          for await (const chunk of Readable.fromWeb(resp.body)) chunks.push(chunk)
          const text = Buffer.concat(chunks).toString("utf8")
          const normalized = streamRequested ? completionToSse(text, up) : null
          res.end(normalized ?? text)
          tally(text, pStat, mStat, sStat)
        }
      } catch (err) {
        if (!res.destroyed && !res.writableEnded) {
          const message = `upstream stream ended unexpectedly: ${err.message ?? String(err)}`
          log(`${exposed} → ошибка потока ${up.name}/${up.model}: ${message}`)
          if (streamRequested) {
            res.write(streamErrorSse(message))
            res.end()
          } else {
            res.destroy()
          }
        }
      } finally {
        if (isSse) tally(tail, pStat, mStat, sStat)
      }
      return
    } catch (err) {
      clearTimeout(timer)
      if (res.destroyed) return // client is gone, nothing to fail over to
      cool(key, ERROR_COOLDOWN_MS)
      pStat.errors++
      usage.failovers++
      mStat.failovers++
      mStat.errors++
      if (sStat) sStat.errors++
      lastError = `${up.name}: ${err.name === "AbortError" ? "timeout" : (err.cause?.code ?? err.message)}`
      log(
        `${exposed} → свитч: ${up.name}/${up.model} заблокирован (${lastError}) на ${fmtDur(ERROR_COOLDOWN_MS)}, пробую следующего`,
      )
    }
  }

  usage.failed++
  hourStat().failed++
  if (!attempted) usage.skipped++
  if (sStat) sStat.errors++ // the client got a 502, so the session sees an error
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
    `provider_proxy on http://127.0.0.1:${listenPort}/v1 — GUI: http://127.0.0.1:${listenPort}/ (${chains.size} models, SQLite: ${dbPath})`,
  )
})
