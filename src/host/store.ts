/**
 * The local directory behind the `@` menu: people, groups, and usage recency.
 *
 * Feishu exposes no "recent conversations" list — `im/v1/chats` returns groups
 * only, and a private chat is reachable solely through a message search. So this
 * store keeps what the API will not: the person directory (built from searches,
 * optionally imported once, and extended as conversations are used), the last
 * time each target was used, and the group list with its activity order.
 * Everything the menu shows is a projection of this file, which keeps ranking
 * synchronous and testable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatItem } from './api.js'
import { matchScore } from './pinyin.js'

/** One person the menu can address. */
export interface Person {
  name: string
  en_name?: string
  open_id: string
  type?: 'internal' | 'external'
  /** Private conversation id, resolved lazily from a send response or a search. */
  chat_id?: string
  /** Last time this person was mentioned, read, or messaged. */
  lastUsedAt?: number
  note?: string
}

/** One group the menu can address. */
export interface Chat {
  chat_id: string
  name: string
  member_count?: number
  external?: boolean
  lastUsedAt?: number
}

/** On-disk state. */
export interface WorkspaceState {
  version: 1
  people: Person[]
  /** Kept in API order: `ByActiveTimeDesc`, so index 0 is the most active group. */
  chats: Chat[]
  chatsUpdatedAt?: number
  seededFrom?: string
  updatedAt: number
}

/** One row of the `@` menu. */
export interface CandidateRow {
  kind: 'person' | 'chat' | 'search'
  /** Search key and display title. */
  name: string
  description?: string
  /** Canonical reference the pick inserts. */
  ref: string
  /** Group heading key. */
  section: 'recent' | 'people' | 'chats' | 'search'
  /** Set for the search fallback row: the text the API should be asked for. */
  search?: string
}

/** What the menu should show for one query. */
export interface RowOptions {
  showChats: boolean
  peopleLimit?: number
  recentLimit?: number
  chatLimit?: number
  totalLimit?: number
}

export const PERSON_PREFIX = 'feishu:user/'
export const CHAT_PREFIX = 'feishu:chat/'

/** Canonical reference for one person. */
export const personRef = (openId: string): string => `${PERSON_PREFIX}${openId}`
/** Canonical reference for one group. */
export const chatRef = (chatId: string): string => `${CHAT_PREFIX}${chatId}`

/** Parse a canonical reference; unknown forms yield undefined. */
export function parseRef(ref: string): { kind: 'person' | 'chat'; id: string } | undefined {
  if (ref.startsWith(PERSON_PREFIX)) {
    const id = ref.slice(PERSON_PREFIX.length)
    return id === '' ? undefined : { kind: 'person', id }
  }
  if (ref.startsWith(CHAT_PREFIX)) {
    const id = ref.slice(CHAT_PREFIX.length)
    return id === '' ? undefined : { kind: 'chat', id }
  }
  return undefined
}

const EMPTY_STATE: WorkspaceState = { version: 1, people: [], chats: [], updatedAt: 0 }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Coarse relative age, matching the menu's right-aligned description budget. */
export function relativeAge(timestamp: number | undefined, now: number): string | undefined {
  if (typeof timestamp !== 'number' || timestamp <= 0) return undefined
  const delta = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${month}-${dayOfMonth}`
}

const normalizeQuery = (query: string): { text: string; chatsOnly: boolean } => {
  const trimmed = query.trim()
  if (trimmed.startsWith('#')) return { text: trimmed.slice(1).toLowerCase(), chatsOnly: true }
  return { text: trimmed.toLowerCase(), chatsOnly: false }
}

/** Owns the state file and every projection the menu needs. */
export class StateStore {
  private state: WorkspaceState

  constructor(
    private readonly file: string,
    private readonly log?: (message: string) => void,
  ) {
    this.state = this.read()
  }

  private read(): WorkspaceState {
    try {
      if (!existsSync(this.file)) return { ...EMPTY_STATE, people: [], chats: [] }
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!isRecord(parsed)) return { ...EMPTY_STATE, people: [], chats: [] }
      const people = Array.isArray(parsed.people) ? parsed.people.filter(isRecord) : []
      const chats = Array.isArray(parsed.chats) ? parsed.chats.filter(isRecord) : []
      return {
        version: 1,
        people: people
          .filter((entry) => typeof entry.open_id === 'string' && typeof entry.name === 'string')
          .map((entry) => entry as unknown as Person),
        chats: chats
          .filter((entry) => typeof entry.chat_id === 'string' && typeof entry.name === 'string')
          .map((entry) => entry as unknown as Chat),
        chatsUpdatedAt: typeof parsed.chatsUpdatedAt === 'number' ? parsed.chatsUpdatedAt : undefined,
        seededFrom: typeof parsed.seededFrom === 'string' ? parsed.seededFrom : undefined,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      }
    } catch (error) {
      this.log?.(`feishu: state file unreadable (${String(error)})`)
      return { ...EMPTY_STATE, people: [], chats: [] }
    }
  }

  private persist(): void {
    this.state.updatedAt = Date.now()
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 1))
    renameSync(temp, this.file)
  }

  get people(): readonly Person[] {
    return this.state.people
  }

  get chats(): readonly Chat[] {
    return this.state.chats
  }

  chatsFresh(ttlMs: number, now = Date.now()): boolean {
    const stamp = this.state.chatsUpdatedAt
    return typeof stamp === 'number' && now - stamp < ttlMs
  }

  /**
   * Import a curated contact list once (opt-in, see `contactsSeedFile`).
   * @returns how many people were added.
   */
  seedFromFile(file: string): number {
    if (this.state.seededFrom !== undefined && this.state.people.length > 0) return 0
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isRecord(parsed) || !Array.isArray(parsed.people)) return 0
      let added = 0
      for (const entry of parsed.people) {
        if (!isRecord(entry)) continue
        const { open_id: openId, name } = entry
        if (typeof openId !== 'string' || typeof name !== 'string' || this.person(openId) !== undefined) continue
        this.state.people.push({
          name,
          open_id: openId,
          type: entry.type === 'external' ? 'external' : 'internal',
          ...(typeof entry.en_name === 'string' ? { en_name: entry.en_name } : {}),
          ...(typeof entry.chat_id === 'string' ? { chat_id: entry.chat_id } : {}),
        })
        added += 1
      }
      this.state.seededFrom = file
      this.persist()
      if (added > 0) this.log?.(`feishu: seeded ${added} contacts from ${file}`)
      return added
    } catch (error) {
      this.log?.(`feishu: cannot seed contacts from ${file}: ${String(error)}`)
      return 0
    }
  }

  /** Replace the group list, preserving locally recorded usage. */
  applyChats(chats: ChatItem[]): void {
    const used = new Map(this.state.chats.map((chat) => [chat.chat_id, chat.lastUsedAt]))
    this.state.chats = chats
      .filter((chat) => typeof chat.name === 'string' && chat.name !== '')
      .map((chat) => ({
        chat_id: chat.chat_id,
        name: chat.name as string,
        ...(typeof chat.member_count === 'number' ? { member_count: chat.member_count } : {}),
        ...(chat.external === true ? { external: true } : {}),
        ...(used.get(chat.chat_id) === undefined ? {} : { lastUsedAt: used.get(chat.chat_id) }),
      }))
    this.state.chatsUpdatedAt = Date.now()
    this.persist()
  }

  /** Find one stored person. */
  person(openId: string): Person | undefined {
    return this.state.people.find((entry) => entry.open_id === openId)
  }

  /** Find one stored group. */
  chat(chatId: string): Chat | undefined {
    return this.state.chats.find((entry) => entry.chat_id === chatId)
  }

  /** Merge people discovered by a server search. */
  mergePeople(people: Array<{ open_id: string; name?: string; en_name?: string }>): number {
    let added = 0
    for (const entry of people) {
      if (this.person(entry.open_id) !== undefined) continue
      const name = entry.name ?? entry.en_name ?? entry.open_id
      this.state.people.push({ name, open_id: entry.open_id, type: 'internal', ...(entry.en_name === undefined ? {} : { en_name: entry.en_name }) })
      added += 1
    }
    if (added > 0) this.persist()
    return added
  }

  /** Record that a person was addressed; also caches the private chat id when known. */
  touchPerson(openId: string, patch: { chat_id?: string; name?: string } = {}): void {
    const existing = this.person(openId)
    if (existing === undefined) {
      this.state.people.push({ name: patch.name ?? openId, open_id: openId, ...(patch.chat_id === undefined ? {} : { chat_id: patch.chat_id }), lastUsedAt: Date.now() })
      this.persist()
      return
    }
    if (patch.chat_id !== undefined) existing.chat_id = patch.chat_id
    if (patch.name !== undefined) existing.name = patch.name
    existing.lastUsedAt = Date.now()
    this.persist()
  }

  /** Record that a group was addressed. */
  touchChat(chatId: string, name?: string): void {
    const existing = this.chat(chatId)
    if (existing === undefined) {
      this.state.chats.unshift({ chat_id: chatId, name: name ?? chatId, lastUsedAt: Date.now() })
      this.persist()
      return
    }
    if (name !== undefined) existing.name = name
    existing.lastUsedAt = Date.now()
    this.persist()
  }

  /**
   * Project one query into menu rows.
   *
   * Empty query is a short roll-up (recent → people → active groups); a typed
   * query filters the whole directory and caps both sections. The group section
   * disappears whenever groups are unavailable, which is what keeps the menu
   * usable before the first chat-list fetch lands.
   */
  rows(query: string, options: RowOptions, now = Date.now()): CandidateRow[] {
    const { text, chatsOnly } = normalizeQuery(query)
    const peopleLimit = options.peopleLimit ?? 12
    const recentLimit = options.recentLimit ?? 6
    const chatLimit = options.chatLimit ?? 5
    const totalLimit = options.totalLimit ?? 25
    const showChats = options.showChats && this.state.chats.length > 0
    const rows: CandidateRow[] = []

    const personRow = (person: Person): CandidateRow => {
      const age = relativeAge(person.lastUsedAt, now)
      const kind = person.type === 'external' ? '外部' : '内部'
      return {
        kind: 'person',
        name: person.name,
        description: age === undefined ? kind : `${kind} · ${age}`,
        ref: personRef(person.open_id),
        section: 'people',
      }
    }

    const chatRow = (chat: Chat): CandidateRow => ({
      kind: 'chat',
      name: chat.name,
      description: [
        typeof chat.member_count === 'number' ? `${chat.member_count} 人` : undefined,
        relativeAge(chat.lastUsedAt, now),
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
      ref: chatRef(chat.chat_id),
      section: 'chats',
    })

    if (text === '') {
      if (!chatsOnly) {
        const byRecency = [...this.state.people]
          .filter((person) => typeof person.lastUsedAt === 'number')
          .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))
          .slice(0, recentLimit)
        const recentIds = new Set(byRecency.map((person) => person.open_id))
        rows.push(...byRecency.map((person) => ({ ...personRow(person), section: 'recent' as const })))
        rows.push(
          ...this.state.people
            .filter((person) => !recentIds.has(person.open_id))
            .slice(0, peopleLimit)
            .map(personRow),
        )
      }
      if (showChats) rows.push(...this.state.chats.slice(0, chatLimit).map(chatRow))
      return rows.slice(0, totalLimit)
    }

    // Ranking is score-first, recency-second: typing `zs` should put 张三 on
    // top even when someone else was messaged more recently.
    const peopleHits = chatsOnly
      ? []
      : this.state.people
          .map((person) => ({ person, score: matchScore(text, person.name, person.en_name) }))
          .filter((entry) => entry.score >= 0)
          .sort(
            (left, right) =>
              right.score - left.score || (right.person.lastUsedAt ?? 0) - (left.person.lastUsedAt ?? 0),
          )
          .slice(0, peopleLimit)
          .map((entry) => personRow(entry.person))
    const chatHits = showChats
      ? this.state.chats
          .map((chat) => ({ chat, score: matchScore(text, chat.name) }))
          .filter((entry) => entry.score >= 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, chatLimit)
          .map((entry) => chatRow(entry.chat))
      : []
    rows.push(...peopleHits, ...chatHits)

    if (rows.length === 0 && text.length >= 2) {
      const search = query.trim().replace(/^#/, '')
      rows.push({
        kind: 'search',
        name: `搜索飞书用户「${search}」`,
        description: '回车搜索',
        ref: '',
        section: 'search',
        search,
      })
    }
    return rows.slice(0, totalLimit)
  }
}
