/**
 * Thin Feishu Open API client.
 *
 * Every call runs with the user access token, so the plugin acts as the person
 * who authorized it: messages are sent under their name and reads see what they
 * can see. The client owns exactly the endpoints this plugin needs and maps
 * Feishu error codes onto {@link FeishuError} codes the UI can act on.
 */
import { API, FeishuError } from './constants.js'
import type { TokenManager } from './token.js'

/** One group from `im/v1/chats`. */
export interface ChatItem {
  chat_id: string
  name?: string
  member_count?: number
  chat_mode?: string
  external?: boolean
  description?: string
}

/** One message from `im/v1/messages`. */
export interface MessageItem {
  message_id: string
  create_time?: string
  msg_type?: string
  body?: { content?: string }
  sender?: { id?: string; sender_type?: string; tenant_key?: string }
  mentions?: Array<{ id?: string; key?: string; name?: string }>
  deleted?: boolean
}

/** One contact from `search/v1/user`. */
export interface PersonItem {
  open_id: string
  name?: string
  en_name?: string
  department_ids?: string[]
}

/** Result of resolving a user-visible name or ref to a conversation target. */
export interface ConversationTarget {
  kind: 'person' | 'chat'
  name: string
  /** `ou_…` for a person, `oc_…` for a group. */
  id: string
  chatId?: string
}

const TOKEN_ERROR_CODES = new Set([99991677, 99991663, 99991400])

const mapCode = (code: number): 'token-expired' | 'not-found' | 'api' => {
  if (TOKEN_ERROR_CODES.has(code)) return 'token-expired'
  if (code === 230002 || code === 232011) return 'not-found'
  return 'api'
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | undefined>
  body?: unknown
}

export class FeishuApi {
  constructor(
    private readonly tokens: TokenManager,
    private readonly log?: (message: string) => void,
  ) {}

  private async request<T>(path: string, options: RequestOptions = {}, retry = true): Promise<T> {
    const token = await this.tokens.accessToken()
    const url = new URL(API + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    let payload: { code?: number; msg?: string; data?: unknown }
    try {
      payload = (await response.json()) as typeof payload
    } catch {
      throw new FeishuError('api', `飞书接口返回非 JSON（HTTP ${response.status}，${path}）`)
    }
    if (payload.code === 0) return (payload.data ?? {}) as T
    const code = payload.code ?? -1
    if (retry && TOKEN_ERROR_CODES.has(code)) {
      this.log?.('feishu: token rejected, refreshing once')
      await this.tokens.refresh()
      return this.request<T>(path, options, false)
    }
    if (code === 230038) {
      // Feishu refuses cross-tenant direct messages outright; a model that only
      // sees the raw code goes off searching the web for it.
      throw new FeishuError(
        'unsupported',
        '飞书不允许跨租户私聊（230038）：对方是外部联系人，改用双方都在的群聊发送，或让对方先发起会话。',
      )
    }
    throw new FeishuError(mapCode(code), `${path} 失败 code=${code} ${(payload.msg ?? '').slice(0, 200)}`.trim())
  }

  /** The authorized person, used by the settings panel. */
  async self(): Promise<{ open_id?: string; name?: string; en_name?: string; avatar_url?: string }> {
    return this.request('/authen/v1/user_info')
  }

  /** Every group the authorized person belongs to, newest-active first. */
  async listChats(maxPages: number): Promise<ChatItem[]> {
    const chats: ChatItem[] = []
    let pageToken: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.request<{ items?: ChatItem[]; page_token?: string; has_more?: boolean }>('/im/v1/chats', {
        query: { page_size: 100, sort_type: 'ByActiveTimeDesc', ...(pageToken === undefined ? {} : { page_token: pageToken }) },
      })
      chats.push(...(data.items ?? []))
      pageToken = data.page_token
      if (pageToken === undefined || data.has_more === false) break
    }
    return chats
  }

  /** Members of one chat, for open_id → display name mapping. */
  async chatMembers(chatId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    let pageToken: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const data = await this.request<{ items?: Array<{ member_id?: string; name?: string }>; page_token?: string }>(
        `/im/v1/chats/${encodeURIComponent(chatId)}/members`,
        { query: { member_id_type: 'open_id', page_size: 100, ...(pageToken === undefined ? {} : { page_token: pageToken }) } },
      )
      for (const member of data.items ?? []) {
        if (typeof member.member_id === 'string' && typeof member.name === 'string') names.set(member.member_id, member.name)
      }
      pageToken = data.page_token
      if (pageToken === undefined) break
    }
    return names
  }

  /** Messages of one conversation, oldest → newest, capped at `limit`. */
  async messages(chatId: string, limit: number): Promise<MessageItem[]> {
    const collected: MessageItem[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 10 && collected.length < limit * 2; page += 1) {
      const data = await this.request<{ items?: MessageItem[]; page_token?: string; has_more?: boolean }>('/im/v1/messages', {
        query: {
          container_id_type: 'chat',
          container_id: chatId,
          page_size: 50,
          sort_type: 'ByCreateTimeDesc',
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
        },
      })
      collected.push(...(data.items ?? []))
      pageToken = data.page_token
      if (pageToken === undefined || data.has_more === false) break
    }
    // Cross-page ordering is not stable: sort on the client before slicing.
    collected.sort((left, right) => Number(left.create_time ?? 0) - Number(right.create_time ?? 0))
    return collected.slice(-limit)
  }

  /**
   * Find the private chat between the authorized person and one other person.
   * Feishu exposes no p2p conversation list, so this is the only way in: search
   * messages sent by that person and take the chat id off the hit metadata.
   */
  async findDirectChatId(openId: string): Promise<string | undefined> {
    for (const query of ['的', '我', '了']) {
      const data = await this.request<{ items?: Array<{ meta_data?: { chat_id?: string; is_p2p_chat?: boolean } }> }>(
        '/im/v1/messages/search',
        { method: 'POST', body: { query, from_ids: [openId], page_size: 20 } },
      )
      const hit = (data.items ?? []).find((item) => item.meta_data?.is_p2p_chat === true)
      if (hit?.meta_data?.chat_id !== undefined) return hit.meta_data.chat_id
    }
    return undefined
  }

  /** Search colleagues by name or pinyin. External contacts are not searchable. */
  async searchUser(query: string): Promise<PersonItem[]> {
    const data = await this.request<{ users?: PersonItem[] }>('/search/v1/user', { method: 'POST', body: { query } })
    return (data.users ?? []).filter((user) => typeof user.open_id === 'string')
  }

  /** Send one message as the authorized person. */
  async sendMessage(input: {
    receiveIdType: 'open_id' | 'chat_id'
    receiveId: string
    msgType: 'text' | 'interactive'
    content: string
  }): Promise<{ message_id?: string; chat_id?: string }> {
    return this.request('/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: input.receiveIdType },
      body: { receive_id: input.receiveId, msg_type: input.msgType, content: input.content },
    })
  }
}
