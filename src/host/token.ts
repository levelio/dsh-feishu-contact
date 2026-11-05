/**
 * Token storage, single-flight refresh, and the cross-process lock.
 *
 * Feishu rotates the refresh token on every use: a refresh token can be spent
 * exactly once, so two readers refreshing the same record race and one of them
 * loses the authorization for good. Every path that can write here therefore
 * refreshes under `O_EXCL` lock, re-reads the record after acquiring it, and
 * only then decides whether a network refresh is needed.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ACCESS_SKEW_SEC, FeishuError, TOKEN_URL } from './constants.js'

/** On-disk token record, plus the optional authorized-user card. */
export interface TokenRecord {
  access_token: string
  expires_at: number
  refresh_token?: string
  refresh_expires_at?: number
  scope?: string
  obtained_at?: number
  flow?: string
  user?: { open_id?: string; name?: string; avatar_url?: string }
}

/** Unix epoch seconds. */
export const nowSec = (): number => Math.floor(Date.now() / 1000)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Read one token record; a missing or unreadable file is not an error. */
export function readTokenFile(file: string): TokenRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(parsed) || typeof parsed.access_token !== 'string') return undefined
    return parsed as unknown as TokenRecord
  } catch {
    return undefined
  }
}

/** Write one token record atomically (temp file + rename, mode 0600). */
export function writeTokenFile(file: string, record: TokenRecord): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(record, null, 1), { mode: 0o600 })
  renameSync(temp, file)
}

/** Whether the access token is unusable at `now`, allowing for clock skew. */
export function isExpired(record: TokenRecord | undefined, skewSec = ACCESS_SKEW_SEC): boolean {
  if (record === undefined || record.access_token === '') return true
  if (typeof record.expires_at !== 'number') return true
  return record.expires_at <= nowSec() + skewSec
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Take an exclusive lock beside the token file.
 * @returns idempotent release function.
 */
export function acquireLock(file: string, options: { timeoutMs?: number; staleMs?: number } = {}): () => void {
  const lockPath = `${file}.lock`
  const timeoutMs = options.timeoutMs ?? 15_000
  const staleMs = options.staleMs ?? 30_000
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600))
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          unlinkSync(lockPath)
        } catch {
          // another process already cleaned up a stale lock
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new FeishuError('lock-timeout', `token 锁超时（${lockPath}）`)
      sleepSync(100)
    }
  }
}

interface ExchangeResponse {
  access_token: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  scope?: string
}

/** Call the OAuth v3 token endpoint with the app credentials. */
export async function exchangeToken(
  body: Record<string, string>,
  appId: string,
  appSecret: string,
): Promise<ExchangeResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ...body, client_id: appId, client_secret: appSecret }),
  })
  const data: unknown = await response.json().catch(() => ({}))
  if (!isObject(data) || typeof data.access_token !== 'string' || data.access_token === '') {
    const detail = JSON.stringify(data).slice(0, 300)
    throw new FeishuError('exchange-failed', `token 接口失败: ${detail}`)
  }
  return data as unknown as ExchangeResponse
}

/** Project one token response into the stored record, carrying the refresh chain forward. */
export function toTokenRecord(data: ExchangeResponse, previous?: TokenRecord): TokenRecord {
  const obtainedAt = nowSec()
  return {
    access_token: data.access_token,
    expires_at: obtainedAt + (data.expires_in ?? 7200),
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    refresh_expires_at:
      data.refresh_token === undefined
        ? previous?.refresh_expires_at
        : obtainedAt + (data.refresh_token_expires_in ?? 0),
    scope: data.scope ?? previous?.scope,
    obtained_at: obtainedAt,
    flow: 'v3',
    user: previous?.user,
  }
}

export interface TokenStatus {
  authorized: boolean
  expired: boolean
  expiresAt?: number
  refreshExpiresAt?: number
  hasRefresh: boolean
  user?: TokenRecord['user']
  lastRefreshAt?: number
}

/** Owns the token file: reads, single-flight refreshes, and status projection. */
export class TokenManager {
  private inflight: Promise<TokenRecord> | null = null

  constructor(
    private readonly options: {
      file: string
      appId?: string
      appSecret?: string
      /** Resolved per refresh so a settings change applies without a reload. */
      credentials?: () => { appId: string; appSecret: string }
      log?: (message: string) => void
    },
  ) {}

  get file(): string {
    return this.options.file
  }

  /** App credentials for the token endpoint, read at call time. */
  private credentials(): { appId: string; appSecret: string } {
    if (this.options.credentials !== undefined) return this.options.credentials()
    return { appId: this.options.appId ?? '', appSecret: this.options.appSecret ?? '' }
  }

  read(): TokenRecord | undefined {
    return readTokenFile(this.options.file)
  }

  status(): TokenStatus {
    const record = this.read()
    if (record === undefined) return { authorized: false, expired: true, hasRefresh: false }
    return {
      authorized: !isExpired(record, 0),
      expired: isExpired(record, 0),
      expiresAt: record.expires_at,
      refreshExpiresAt: record.refresh_expires_at,
      hasRefresh: typeof record.refresh_token === 'string' && record.refresh_token !== '',
      user: record.user,
      lastRefreshAt: record.obtained_at,
    }
  }

  /** Persist a freshly exchanged record. */
  save(record: TokenRecord): void {
    writeTokenFile(this.options.file, record)
  }

  /** A usable access token, refreshing once when the current one is stale. */
  async accessToken(): Promise<string> {
    const record = this.read()
    if (record !== undefined && !isExpired(record)) return record.access_token
    if (record === undefined) throw new FeishuError('no-token', `没有飞书授权（${this.options.file}）`)
    const refreshed = await this.refresh()
    return refreshed.access_token
  }

  /** Refresh unless a concurrent refresher already produced a valid record. */
  async refresh(): Promise<TokenRecord> {
    if (this.inflight !== null) return this.inflight
    const task = (async (): Promise<TokenRecord> => {
      const release = acquireLock(this.options.file)
      try {
        // Re-read under the lock: a parallel writer may have just rotated it.
        const current = this.read()
        if (current !== undefined && !isExpired(current)) return current
        if (current === undefined) throw new FeishuError('no-token', `没有飞书授权（${this.options.file}）`)
        if (typeof current.refresh_token !== 'string' || current.refresh_token === '') {
          throw new FeishuError('no-refresh-token', '授权里没有 refresh_token，需要重新授权')
        }
        if (typeof current.refresh_expires_at === 'number' && current.refresh_expires_at <= nowSec() + 60) {
          throw new FeishuError('refresh-expired', '刷新凭证已过期，需要重新授权')
        }
        const { appId, appSecret } = this.credentials()
        const data = await exchangeToken(
          { grant_type: 'refresh_token', refresh_token: current.refresh_token },
          appId,
          appSecret,
        )
        const next = toTokenRecord(data, current)
        this.save(next)
        this.options.log?.('feishu: access token refreshed')
        return next
      } finally {
        release()
      }
    })()
    this.inflight = task
    try {
      return await task
    } finally {
      this.inflight = null
    }
  }

  /** Store a record obtained by the interactive authorization flow. */
  adopt(record: TokenRecord): void {
    const previous = this.read()
    writeTokenFile(this.options.file, {
      ...record,
      refresh_token: record.refresh_token ?? previous?.refresh_token,
      refresh_expires_at: record.refresh_token === undefined ? previous?.refresh_expires_at : record.refresh_expires_at,
    })
  }

}
