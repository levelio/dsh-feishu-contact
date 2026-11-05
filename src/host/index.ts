/**
 * Host half of the Feishu contact plugin.
 *
 * Owns the authorization, the directory cache, and the two RPC surfaces the
 * browser half and the model use: `@` candidates for the composer, and the
 * `feishu_*` tools for reading and sending. Nothing here touches the workspace —
 * the only state is the plugin's own authorization and directory files.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  FeishuError,
  MAX_CHAT_PAGES,
  REFRESH_TICK_MS,
  failureOf,
} from './constants.js'
import { chatsAllowed, normalizeConfig, type PluginConfig } from './config.js'
import { nowSec, TokenManager } from './token.js'
import { FeishuApi, type ConversationTarget } from './api.js'
import { chatRef, parseRef, personRef, StateStore, type CandidateRow } from './store.js'
import { AuthFlow } from './auth.js'
import { FEISHU_REFERENCE_PROMPT } from './prompt.js'
import { registerFeishuTools, type FeishuRuntime } from './tools.js'
import { buildCardContent, buildTextContent, maskSecret, renderConversation } from './format.js'

/** A menu-level note the composer renders above the Feishu group. */
export interface FeishuNotice {
  kind: 'auth' | 'syncing' | 'error'
  message: string
}

/** What `candidates` answers over RPC. */
export interface CandidateAnswer {
  rows: CandidateRow[]
  notice?: FeishuNotice
}

/** What the settings panel reads. */
export interface AuthStatus {
  /** Whether an app id/secret is configured; nothing works before it is. */
  configured: boolean
  /** The redirect URI that must be registered on that Feishu app. */
  redirectUri: string
  /** Configured app id; the secret itself is never echoed back. */
  appId?: string
  /** `abc*******` preview so the panel can show that a secret is stored. */
  appSecretMask?: string
  /** Message form the panel edits. */
  messageFormat?: 'card' | 'text'
  authorized: boolean
  pending: boolean
  expiresAt?: number
  refreshExpiresAt?: number
  lastRefreshAt?: number
  tokenFile: string
  user?: { open_id?: string; name?: string; avatar_url?: string }
  error?: string
}

export class FeishuContactService extends TypertRemoteService implements FeishuRuntime {
  static inject = ['agents']

  static Config = Schema.object({
    tokenFile: Schema.string().default('').description('授权文件路径（留空 = ~/.dsh/feishu-contact/user-token.json）'),
    showChats: Schema.union([
      Schema.const('auto').description('能列出群组时才显示'),
      Schema.const('on').description('总是显示群组'),
      Schema.const('off').description('不显示群组'),
    ])
      .default('auto')
      .description('群组是否出现在 @ 菜单'),
    messageFormat: Schema.union([
      Schema.const('card').description('卡片（支持 markdown）'),
      Schema.const('text').description('纯文本'),
    ])
      .default('card')
      .volatile()
      .description('发送消息的默认形态'),
    requireApproval: Schema.boolean().default(false).volatile().description('发送前要求确认'),
    defaultLimit: Schema.number().default(30).description('读取会话的默认条数'),
    cacheTtlMs: Schema.number().default(600_000).description('群列表缓存时长（毫秒）'),
    autoRefresh: Schema.boolean().default(true).description('后台自动续期授权'),
    contactsSeedFile: Schema.string()
      .default('')
      .description('可选：首次启动时从一个联系人 JSON 文件导入（{ people: [{ name, open_id }] }），留空则不导入'),
    appId: Schema.string()
      .default('')
      .volatile()
      .description('飞书自建应用的 App ID（开放平台 → 你的应用 → 凭证与基础信息）'),
    appSecret: Schema.string()
      .default('')
      .volatile()
      .description('飞书自建应用的 App Secret（保存在本机 profile 配置里）'),
    redirectPort: Schema.number().default(3000).volatile().description('OAuth 回调端口（须与飞书后台登记一致）'),
  })

  readonly config: PluginConfig
  private readonly ctxRef: any
  private readonly tokens: TokenManager
  private readonly store: StateStore
  private readonly api: FeishuApi
  private readonly auth: AuthFlow
  private readonly settingsFile: string
  private chatRefresh: Promise<void> | null = null
  private promptFibers = new Map<unknown, unknown>()
  private lastError: string | undefined

  constructor(ctx: any, config: Partial<PluginConfig>) {
    super(ctx, 'feishu')
    this.ctxRef = ctx
    this.config = normalizeConfig(config)
    const log = (message: string) => {
      try {
        ctx.logger?.info?.(message)
      } catch {
        // logging is best-effort
      }
    }
    // Credentials are read per call: the settings page can change them without a
    // plugin reload, and `applyCredentials` refreshes the in-memory copy.
    const credentials = () => ({ appId: this.config.appId, appSecret: this.config.appSecret })
    this.tokens = new TokenManager({ file: this.config.tokenFile, credentials, log })
    this.store = new StateStore(this.config.stateFile, log)
    this.api = new FeishuApi(this.tokens, log)
    this.auth = new AuthFlow({
      credentials,
      port: this.config.redirectPort,
      tokenFile: this.config.tokenFile,
      log,
    })

    // The settings panel manages its own 0600 file next to the state, so UI edits
    // apply instantly (no profile recomposition) and survive a restart. Values
    // present in the file override the profile config.
    this.settingsFile = join(dirname(this.config.stateFile), 'settings.json')
    const stored = readSettingsFile(this.settingsFile)
    if (stored !== undefined) {
      if (typeof stored.appId === 'string' && stored.appId !== '') this.config.appId = stored.appId
      if (typeof stored.appSecret === 'string' && stored.appSecret !== '') this.config.appSecret = stored.appSecret
      if (stored.messageFormat === 'card' || stored.messageFormat === 'text') {
        this.config.messageFormat = stored.messageFormat
      }
    }

    // Fully self-contained: this plugin never reads another tool's authorization
    // or state. A directory seed is opt-in through `contactsSeedFile`.
    if (this.config.contactsSeedFile !== '') this.store.seedFromFile(this.config.contactsSeedFile)

    ctx.inject(['tools'], (scope: any) => {
      try {
        registerFeishuTools(scope, this)
        log('feishu-contact: registered 3 tools (read / send / find)')
      } catch (error) {
        // A throw here removes the plugin's whole model surface, and the only
        // symptom is a model that improvises with bash. Never swallow it.
        log(`feishu-contact: tool registration FAILED: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    this.installPrompts(ctx)
    if (this.config.autoRefresh) this.startRefreshTimer(ctx)
    void this.refreshTick()
  }

  // --- RPC surface (browser) ------------------------------------------------

  /** Rows for the composer `@` menu. Never throws: failures become a notice. */
  @Remote('candidates')
  async candidates(query: string, signal?: AbortSignal): Promise<CandidateAnswer> {
    if (signal?.aborted === true) return { rows: [] }
    try {
      await this.tokens.accessToken()
    } catch (error) {
      const failure = failureOf(error)
      this.lastError = failure.message
      return { rows: [], notice: { kind: 'auth', message: error instanceof FeishuError ? error.hint : failure.message } }
    }
    // Kick a chat-list refresh without making the keystroke wait for it.
    if (chatsAllowed(this.config) && !this.store.chatsFresh(this.config.cacheTtlMs)) {
      void this.ensureChats().catch((error: unknown) => {
        this.lastError = failureOf(error).message
      })
    }
    const typed = query.trim() !== ''
    const rows = this.store.rows(query, {
      showChats: chatsAllowed(this.config) && this.store.chats.length > 0,
      peopleLimit: typed ? 8 : 12,
      recentLimit: 6,
      chatLimit: typed ? 8 : 5,
      totalLimit: 25,
    })
    if (rows.length === 0 && !typed && this.store.chats.length === 0 && chatsAllowed(this.config)) {
      return { rows, notice: { kind: 'syncing', message: '正在同步飞书群组…' } }
    }
    return { rows }
  }

  /** Authorization state for the settings panel. */
  @Remote('authStatus')
  async authStatus(): Promise<AuthStatus> {
    const status = this.tokens.status()
    return {
      configured: this.config.appId !== '' && this.config.appSecret !== '',
      redirectUri: `http://localhost:${this.config.redirectPort}/callback`,
      ...(this.config.appId === '' ? {} : { appId: this.config.appId }),
      ...(this.config.appSecret === '' ? {} : { appSecretMask: maskSecret(this.config.appSecret) }),
      messageFormat: this.config.messageFormat,
      authorized: status.authorized,
      pending: this.auth.isPending,
      expiresAt: status.expiresAt,
      refreshExpiresAt: status.refreshExpiresAt,
      lastRefreshAt: status.lastRefreshAt,
      tokenFile: this.config.tokenFile,
      user: status.user,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }

  /** Start an interactive authorization; the browser opens on the host side. */
  @Remote('authorize')
  async authorize(): Promise<{ url?: string; port?: number; error?: string }> {
    try {
      return await this.auth.begin()
    } catch (error) {
      const failure = failureOf(error)
      this.lastError = failure.message
      return { error: error instanceof FeishuError ? error.hint : failure.message }
    }
  }

  /**
   * Adopt settings edited in the panel.
   *
   * Accepts a partial update (any of appId / appSecret / messageFormat), applies
   * it to the running service immediately, and persists the
   * UI-managed subset to the plugin's own file so it survives a restart without a
   * profile recomposition.
   */
  @Remote('applySettings')
  async applySettings(
    appId?: string,
    appSecret?: string,
    messageFormat?: string,
  ): Promise<{ ok: boolean; configured: boolean; file: string }> {
    if (typeof appId === 'string') this.config.appId = appId.trim()
    if (typeof appSecret === 'string') this.config.appSecret = appSecret.trim()
    const requestedFormat = normalizeMessageFormat(messageFormat)
    if (requestedFormat !== undefined) this.config.messageFormat = requestedFormat
    try {
      writeSettingsFile(this.settingsFile, {
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        messageFormat: this.config.messageFormat,
      })
      this.lastError = undefined
    } catch (error) {
      // In-memory values still apply, but they will not survive a restart.
      this.lastError = failureOf(error).message
    }
    return {
      ok: true,
      configured: this.config.appId !== '' && this.config.appSecret !== '',
      file: this.settingsFile,
    }
  }

  /** Force one refresh attempt, e.g. from the settings panel. */
  @Remote('refreshToken')
  async refreshToken(): Promise<{ ok: boolean; message?: string; expiresAt?: number }> {
    try {
      const record = await this.tokens.refresh()
      this.lastError = undefined
      return { ok: true, expiresAt: record.expires_at }
    } catch (error) {
      const failure = failureOf(error)
      this.lastError = failure.message
      return { ok: false, message: error instanceof FeishuError ? error.hint : failure.message }
    }
  }

  /** Verify the authorization end to end (settings panel "test" button). */
  @Remote('probe')
  async probe(): Promise<{ ok: boolean; user?: string; chats?: number; people?: number; message?: string }> {
    try {
      const me = await this.api.self()
      await this.ensureChats(true)
      return { ok: true, user: me.name ?? me.open_id, chats: this.store.chats.length, people: this.store.people.length }
    } catch (error) {
      const failure = failureOf(error)
      this.lastError = failure.message
      return { ok: false, message: error instanceof FeishuError ? error.hint : failure.message }
    }
  }

  /**
   * Reference → display name directory for transcript chips.
   *
   * The client's text matcher must resolve names synchronously, so it keeps this
   * map locally and refreshes it whenever candidates arrive anyway.
   */
  @Remote('directory')
  async directory(): Promise<{ names: Record<string, string> }> {
    const names: Record<string, string> = {}
    for (const person of this.store.people) names[personRef(person.open_id)] = person.name
    for (const chat of this.store.chats) names[chatRef(chat.chat_id)] = chat.name
    return { names }
  }

  /** Whether a reference still resolves; called when the draft is submitted. */
  @Remote('validate')
  async validate(ref: string): Promise<{ ok: boolean; name?: string; message?: string }> {
    const parsed = parseRef(ref)
    if (parsed === undefined) return { ok: false, message: '引用格式不对' }
    if (parsed.kind === 'chat') {
      const chat = this.store.chat(parsed.id)
      return chat === undefined ? { ok: false, message: '这个群不在缓存里（可能已退群）' } : { ok: true, name: chat.name }
    }
    const person = this.store.person(parsed.id)
    return person === undefined ? { ok: false, message: '这个联系人不在缓存里' } : { ok: true, name: person.name }
  }

  /**
   * Server-backed fallback used only when the local directory has no hit.
   * The composer reaches this after the keystroke settles, so one typed query
   * costs at most one search call.
   */
  @Remote('searchCandidates')
  async searchCandidates(query: string, signal?: AbortSignal): Promise<CandidateAnswer> {
    if (signal?.aborted === true) return { rows: [] }
    try {
      await this.tokens.accessToken()
    } catch (error) {
      const failure = failureOf(error)
      this.lastError = failure.message
      return { rows: [], notice: { kind: 'auth', message: error instanceof FeishuError ? error.hint : failure.message } }
    }
    try {
      const rows = await this.findContacts(query, true)
      return { rows }
    } catch (error) {
      const failure = failureOf(error)
      this.lastError = failure.message
      return { rows: [], notice: { kind: 'error', message: failure.message } }
    }
  }

  // --- FeishuRuntime (tools) -----------------------------------------------

  async resolveTarget(target: string): Promise<ConversationTarget> {
    const trimmed = target.trim()
    const parsed = parseRef(trimmed)
    if (parsed?.kind === 'chat') {
      const chat = this.store.chat(parsed.id)
      return { kind: 'chat', id: parsed.id, name: chat?.name ?? parsed.id }
    }
    if (parsed?.kind === 'person') {
      const person = this.store.person(parsed.id)
      return { kind: 'person', id: parsed.id, name: person?.name ?? parsed.id }
    }
    if (trimmed.startsWith('ou_')) {
      const person = this.store.person(trimmed)
      return { kind: 'person', id: trimmed, name: person?.name ?? trimmed }
    }
    if (trimmed.startsWith('oc_')) {
      const chat = this.store.chat(trimmed)
      return { kind: 'chat', id: trimmed, name: chat?.name ?? trimmed }
    }
    const candidates = await this.findContacts(trimmed, true)
    const exact = candidates.filter((row) => row.name === trimmed)
    const pool = exact.length > 0 ? exact : candidates
    if (pool.length === 0) throw new FeishuError('not-found', `找不到飞书里的「${trimmed}」`)
    if (pool.length > 1) {
      throw new FeishuError('ambiguous', `「${trimmed}」匹配到多个：${pool.map((row) => row.name).join('、')}`)
    }
    return this.resolveTarget(pool[0].ref)
  }

  async readConversation(
    target: string,
    limit: number,
  ): Promise<{ target: ConversationTarget; transcript: string; count: number; truncated: boolean }> {
    const resolved = await this.resolveTarget(target)
    const chatId = resolved.kind === 'chat' ? resolved.id : await this.ensureDirectChat(resolved)
    const [messages, names, meOpenId] = await Promise.all([
      this.api.messages(chatId, limit),
      this.api.chatMembers(chatId).catch(() => new Map<string, string>()),
      this.selfOpenId(),
    ])
    for (const person of this.store.people) if (person.name !== '') names.set(person.open_id, person.name)
    const rendered = renderConversation(messages, names, meOpenId)
    if (resolved.kind === 'chat') this.store.touchChat(resolved.id, resolved.name)
    else this.store.touchPerson(resolved.id, { chat_id: chatId, name: resolved.name })
    return {
      target: resolved,
      transcript: rendered.text === '' ? '（这个会话还没有消息）' : rendered.text,
      count: rendered.messages.length,
      truncated: messages.length >= limit,
    }
  }

  async sendMessage(input: {
    target: string
    text: string
    format?: 'card' | 'text'
  }): Promise<{ target: ConversationTarget; messageId?: string; chatId?: string }> {
    const resolved = await this.resolveTarget(input.target)
    // An explicit per-message request ("用卡片发") overrides the configured
    // default; an omitted or unrecognized value falls back to the default.
    const format = normalizeMessageFormat(input.format) ?? this.config.messageFormat
    const msgType = format === 'card' ? 'interactive' : 'text'
    const content = format === 'card' ? buildCardContent(input.text) : buildTextContent(input.text)
    if (resolved.kind === 'chat') {
      const sent = await this.api.sendMessage({
        receiveIdType: 'chat_id',
        receiveId: resolved.id,
        msgType,
        content,
      })
      this.store.touchChat(resolved.id, resolved.name)
      return { target: resolved, messageId: sent.message_id, chatId: sent.chat_id }
    }
    const sent = await this.api.sendMessage({
      receiveIdType: 'open_id',
      receiveId: resolved.id,
      msgType,
      content,
    })
    this.store.touchPerson(resolved.id, {
      name: resolved.name,
      ...(sent.chat_id === undefined ? {} : { chat_id: sent.chat_id }),
    })
    return { target: resolved, messageId: sent.message_id, chatId: sent.chat_id }
  }

  async findContacts(query: string, includeChats: boolean): Promise<CandidateRow[]> {
    const typed = query.trim() !== ''
    const local = this.store
      .rows(query, {
        showChats: includeChats && chatsAllowed(this.config) && this.store.chats.length > 0,
        peopleLimit: typed ? 10 : 20,
        chatLimit: typed ? 10 : 20,
        totalLimit: 30,
      })
      .filter((row) => row.kind !== 'search')
    if (local.length > 0 || query.trim().length < 2) return local
    // Nothing local: ask Feishu, then re-project from the enriched cache.
    await this.api.searchUser(query.trim()).then((people) => this.store.mergePeople(people))
    return this.store
      .rows(query, {
        showChats: includeChats && chatsAllowed(this.config) && this.store.chats.length > 0,
        peopleLimit: 10,
        chatLimit: 10,
        totalLimit: 30,
      })
      .filter((row) => row.kind !== 'search')
  }

  async requestApproval(reason: string, signal?: AbortSignal): Promise<boolean> {
    const approval = this.ctxRef.get('approval')
    if (approval === undefined) return false
    try {
      const outcome = await approval.request({ toolName: 'feishu_send_message', reason, signal })
      return outcome === 'allowed-once'
    } catch {
      return false
    }
  }

  /** Dispose the authorization listener with the service. */
  dispose(): void {
    this.auth.dispose()
    try {
      ;(super.dispose as (() => void) | undefined)?.()
    } catch {
      // the base service may be a no-op disposer
    }
  }

  // --- internals -----------------------------------------------------------

  private async ensureDirectChat(resolved: ConversationTarget): Promise<string> {
    const person = this.store.person(resolved.id)
    if (person?.chat_id !== undefined) return person.chat_id
    const found = await this.api.findDirectChatId(resolved.id)
    if (found === undefined) {
      throw new FeishuError('not-found', `还没有和「${resolved.name}」的私聊记录，先发一条消息才能读取`)
    }
    this.store.touchPerson(resolved.id, { chat_id: found, name: resolved.name })
    return found
  }

  private async ensureChats(force = false): Promise<void> {
    if (!chatsAllowed(this.config)) return
    if (!force && this.store.chatsFresh(this.config.cacheTtlMs)) return
    if (this.chatRefresh !== null) return this.chatRefresh
    this.chatRefresh = (async () => {
      try {
        const chats = await this.api.listChats(MAX_CHAT_PAGES)
        this.store.applyChats(chats)
        this.lastError = undefined
      } finally {
        this.chatRefresh = null
      }
    })()
    return this.chatRefresh
  }

  private async selfOpenId(): Promise<string | undefined> {
    const record = this.tokens.read()
    if (record?.user?.open_id !== undefined) return record.user.open_id
    try {
      const me = await this.api.self()
      if (record !== undefined && me.open_id !== undefined) {
        this.tokens.save({ ...record, user: { open_id: me.open_id, name: me.name, avatar_url: me.avatar_url } })
      }
      return me.open_id
    } catch {
      return undefined
    }
  }

  private installPrompts(ctx: any): void {
    const install = (agent: any): void => {
      if (agent === undefined || this.promptFibers.has(agent)) return
      try {
        const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope: any) => {
          if (scope.tools.get('feishu_send_message', agent) === undefined) return
          scope.systemPrompt.section({
            name: 'context:feishu-contact',
            order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
            text: () => FEISHU_REFERENCE_PROMPT,
          })
        })
        this.promptFibers.set(agent, fiber)
      } catch {
        // an agent without a prompt surface simply gets no guidance
      }
    }
    try {
      for (const agent of ctx.agents?.list?.() ?? []) install(agent)
    } catch {
      // ignore
    }
    ctx.on('agent/created', ({ agent }: { agent: unknown }) => install(agent))
  }

  private startRefreshTimer(ctx: any): void {
    const timer = setInterval(() => void this.refreshTick(), REFRESH_TICK_MS)
    timer.unref?.()
    try {
      ctx.effect(() => () => clearInterval(timer))
    } catch {
      // without an effect scope the interval simply dies with the process
    }
  }

  /** Refresh when the access token is about to expire; no-op otherwise. */
  private async refreshTick(): Promise<void> {
    if (this.auth.isPending) return
    const status = this.tokens.status()
    if (!status.authorized && !status.hasRefresh) return
    const expiresAt = status.expiresAt ?? 0
    if (expiresAt - nowSec() > 20 * 60) return
    try {
      await this.tokens.refresh()
      this.lastError = undefined
    } catch (error) {
      this.lastError = failureOf(error).message
    }
  }
}

/** The UI-managed settings subset persisted beside the state file. */
interface StoredSettings {
  appId: string
  appSecret: string
  messageFormat?: 'card' | 'text'
}

/** Read the local settings; a missing or unreadable file is not an error. */
function readSettingsFile(file: string): Partial<StoredSettings> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredSettings>
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Persist settings locally (0600, atomic replace). */
function writeSettingsFile(file: string, value: StoredSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 })
  renameSync(temp, file)
}

/** Map a requested message form to `card` / `text`; unknown values yield undefined. */
export function normalizeMessageFormat(value: unknown): 'card' | 'text' | undefined {
  if (typeof value !== 'string') return undefined
  const lowered = value.trim().toLowerCase()
  if (lowered === 'card' || lowered === '卡片' || lowered === 'interactive') return 'card'
  if (lowered === 'text' || lowered === '文本' || lowered === 'plain') return 'text'
  return undefined
}

export default FeishuContactService
