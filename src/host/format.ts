/**
 * Message projection: Feishu's wire bodies → text a model can read.
 *
 * Two wire details decide the shape: mentions arrive as `@_user_1` placeholders
 * whose real identity lives in `mentions[]` (so text must be rewritten through
 * that array, never by regex on `<at>`), and `create_time` is a millisecond
 * string, not a number.
 */
import type { MessageItem } from './api.js'

/** Replace `@_user_N` placeholders with the names carried by `mentions[]`. */
export function applyMentions(message: MessageItem, text: string): string {
  let output = text
  for (const mention of message.mentions ?? []) {
    if (typeof mention.key !== 'string' || mention.key === '') continue
    const label = mention.name ?? mention.id ?? '某人'
    output = output.split(mention.key).join(`@${label}`)
  }
  return output
}

const flattenPost = (content: Record<string, unknown>): string => {
  const title = typeof content.title === 'string' ? content.title : ''
  const blocks = Array.isArray(content.content) ? content.content : []
  const lines: string[] = []
  for (const block of blocks) {
    if (!Array.isArray(block)) continue
    const parts: string[] = []
    for (const element of block) {
      if (typeof element !== 'object' || element === null) continue
      const node = element as Record<string, unknown>
      if (typeof node.text === 'string') parts.push(node.text)
      else if (typeof node.href === 'string') parts.push(node.href)
      else if (typeof node.user_id === 'string') parts.push(`@${String(node.user_name ?? node.user_id)}`)
    }
    if (parts.length > 0) lines.push(parts.join(''))
  }
  return [title, ...lines].filter((line) => line !== '').join('\n')
}

/** One message body as plain text; unknown kinds degrade to a bracketed tag. */
export function messageText(message: MessageItem): string {
  let content: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(message.body?.content ?? '{}')
    if (typeof parsed === 'object' && parsed !== null) content = parsed as Record<string, unknown>
  } catch {
    content = {}
  }
  const type = message.msg_type ?? 'unknown'
  switch (type) {
    case 'text':
      return applyMentions(message, typeof content.text === 'string' ? content.text : '')
    case 'post':
      return applyMentions(message, `[富文本] ${flattenPost(content)}`)
    case 'image':
      return '[图片]'
    case 'file':
      return `[文件] ${String(content.file_name ?? '')}`.trim()
    case 'audio':
      return '[语音]'
    case 'media':
      return '[视频]'
    case 'sticker':
      return '[表情]'
    case 'interactive':
      return '[卡片]'
    case 'share_chat':
      return `[群名片] ${String(content.chat_name ?? content.chatname ?? '')}`.trim()
    case 'share_user':
      return '[个人名片]'
    case 'merge_forward':
      return '[合并转发]'
    case 'system':
      return `[系统] ${String(content.template ?? '')}`.trim()
    default:
      return `[${type}]`
  }
}

const stamp = (createTime: string | undefined, now: Date): string => {
  const raw = Number(createTime ?? 0)
  if (!Number.isFinite(raw) || raw <= 0) return '--'
  const date = new Date(raw > 1e12 ? raw : raw * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}-${day} ${clock}`
}

export interface ConversationRender {
  messages: Array<{ at: string; from: string; text: string; type: string; mine: boolean }>
  text: string
}

/**
 * Project a conversation into the model-facing transcript.
 * @param messages - oldest → newest, already capped by the caller.
 * @param names - open_id → display name for senders seen in this chat.
 * @param meOpenId - the authorized person's open_id, rendered as `我`.
 */
export function renderConversation(
  messages: MessageItem[],
  names: Map<string, string>,
  meOpenId: string | undefined,
  now = new Date(),
): ConversationRender {
  const rows = messages.map((message) => {
    const senderId = message.sender?.id
    const mine = senderId !== undefined && meOpenId !== undefined && senderId === meOpenId
    const from =
      mine
        ? '我'
        : message.sender?.sender_type === 'app'
          ? '机器人'
          : (senderId === undefined ? '未知' : names.get(senderId) ?? senderId.slice(0, 10))
    return {
      at: stamp(message.create_time, now),
      from,
      text: messageText(message).replace(/\n/g, '\n    '),
      type: message.msg_type ?? 'unknown',
      mine,
    }
  })
  const text = rows.map((row) => `[${row.at}] ${row.from}: ${row.text}`).join('\n')
  return { messages: rows, text }
}

/** Card JSON 2.0 wrapping one markdown body. */
export function buildCardContent(text: string): string {
  return JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } })
}

export function buildTextContent(text: string): string {
  return JSON.stringify({ text })
}

/**
 * Display preview of a stored secret: first three characters plus a fixed mask.
 * Enough to recognize which app is configured, never enough to use it — and a
 * constant mask keeps the real length private.
 */
export function maskSecret(secret: string): string {
  if (secret === '') return ''
  return `${secret.slice(0, 3)}*******`
}
