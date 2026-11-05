/**
 * Model-facing tools over the Feishu surface.
 *
 * Each tool answers `{ ok, summary, detail }`: `summary` is one line a person can
 * scan in the transcript, `detail` is what the model reads. Failures come back as
 * data rather than exceptions so a denied authorization or a missing contact
 * turns into guidance instead of a broken turn.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FeishuError, failureOf } from './constants.js'
import type { PluginConfig } from './config.js'
import type { ConversationTarget } from './api.js'
import type { CandidateRow } from './store.js'

/** The host-side capabilities the tools act through (implemented by the service). */
export interface FeishuRuntime {
  readonly config: PluginConfig
  /** Resolve a mention reference, a raw id, or a unique name to one target. */
  resolveTarget(target: string): Promise<ConversationTarget>
  readConversation(target: string, limit: number): Promise<{
    target: ConversationTarget
    transcript: string
    count: number
    truncated: boolean
  }>
  sendMessage(input: { target: string; text: string; format?: 'card' | 'text' }): Promise<{
    target: ConversationTarget
    messageId?: string
    chatId?: string
  }>
  findContacts(query: string, includeChats: boolean): Promise<CandidateRow[]>
  /** Whether an interactive approval channel exists for this call. */
  requestApproval(reason: string, signal?: AbortSignal): Promise<boolean>
}

interface ToolResult {
  ok: boolean
  summary: string
  detail: string
}

/**
 * Output schema in the tool value-schema DSL.
 *
 * `output.schema` is NOT raw JSON Schema: requiredness is a per-property
 * `required: true` annotation and an object root must state its openness.
 * A top-level `required: [...]` array is rejected at registration time, which
 * silently removes every tool — the failure mode this comment exists to prevent.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    summary: { type: 'string', required: true },
    detail: { type: 'string', required: true },
  },
}

const render = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => {
  const result = value as ToolResult
  return [{ type: 'text', text: result.detail === '' ? result.summary : `${result.summary}\n\n${result.detail}` }]
}

const failure = (error: unknown): ToolResult => {
  const { code, message } = failureOf(error)
  const summary =
    error instanceof FeishuError
      ? error.hint
      : `飞书调用失败（${code}）`
  return { ok: false, summary, detail: message }
}

const targetName = (target: ConversationTarget): string =>
  target.kind === 'chat' ? `群「${target.name}」` : `${target.name}`

/** Register the Feishu tools in the scope that owns the tool registry. */
export function registerFeishuTools(scope: any, runtime: FeishuRuntime): void {
  scope.tools.register(
    defineTool({
      name: 'feishu_read_conversation',
      description:
        'Read recent messages of a Feishu private chat or group as the user. Use it whenever a @[Name](feishu:…) mention is involved and the answer depends on what was said. Returns oldest-first messages with sender names.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: 'A feishu mention reference (feishu:user/ou_… or feishu:chat/oc_…), a raw open_id/chat_id, or a person/group name.',
        },
        limit: {
          type: 'number',
          description: 'How many recent messages to read (default from settings, max 100).',
        },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: { target: string; limit?: number }, exec: { signal?: AbortSignal }) {
        if (exec.signal?.aborted === true) return { ok: false, summary: '已取消', detail: '' }
        try {
          const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? runtime.config.defaultLimit)))
          const result = await runtime.readConversation(args.target, limit)
          const summary = `已读取${targetName(result.target)}的最近 ${result.count} 条消息`
          return {
            ok: true,
            summary: result.truncated ? `${summary}（已截断）` : summary,
            detail: result.transcript,
          }
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )

  scope.tools.register(
    defineTool({
      name: 'feishu_send_message',
      description:
        'Send a Feishu message as the user to a private chat or group. Use the mention reference as target. Returns the message id; never claim delivery without it.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: 'A feishu mention reference (feishu:user/ou_… or feishu:chat/oc_…), a raw open_id/chat_id, or an unambiguous person/group name.',
        },
        text: {
          type: 'string',
          required: true,
          description: 'Message body. Markdown is supported because cards render it; keep it short and conversational.',
        },
        format: {
          type: 'string',
          description:
            "'card' (markdown bubble) or 'text' (plain). Pass this ONLY when the user explicitly asks for a form in their message (卡片/card → 'card', 文本/纯文本/text → 'text'); omit it to use the configured default.",
        },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: { target: string; text: string; format?: 'card' | 'text' }, exec: { signal?: AbortSignal }) {
        if (exec.signal?.aborted === true) return { ok: false, summary: '已取消', detail: '' }
        try {
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (text === '') return { ok: false, summary: '消息内容是空的', detail: '' }
          const target = await runtime.resolveTarget(args.target)
          if (runtime.config.requireApproval) {
            const allowed = await runtime.requestApproval(
              `向${targetName(target)}发送飞书消息：${text.slice(0, 80)}`,
              exec.signal,
            )
            if (!allowed) return { ok: false, summary: '发送已取消', detail: '用户没有批准这次发送。' }
          }
          const sent = await runtime.sendMessage({ target: args.target, text, format: args.format })
          return {
            ok: true,
            summary: `已发送给${targetName(sent.target)}`,
            detail: [
              sent.messageId === undefined ? undefined : `message_id: ${sent.messageId}`,
              sent.chatId === undefined ? undefined : `chat_id: ${sent.chatId}`,
            ]
              .filter(Boolean)
              .join('\n'),
          }
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )

  scope.tools.register(
    defineTool({
      name: 'feishu_find_contact',
      description:
        'Look up Feishu people and groups by name. Use it when the user names someone without an @ mention, then pass the returned reference to feishu_read_conversation or feishu_send_message.',
      parameters: {
        query: { type: 'string', required: true, description: 'Name, pinyin, or part of a group name.' },
        include_chats: { type: 'boolean', description: 'Include groups in the result (default true).' },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      async execute(args: { query: string; include_chats?: boolean }) {
        try {
          const rows = await runtime.findContacts(args.query ?? '', args.include_chats !== false)
          if (rows.length === 0) {
            return { ok: true, summary: `没有找到「${args.query}」`, detail: '可以试试拼音，或者让用户从群里提供线索。' }
          }
          const detail = rows
            .map((row) => `- ${row.kind === 'chat' ? '群' : '人'} ${row.name}${row.description === undefined ? '' : `（${row.description}）`} → ${row.ref}`)
            .join('\n')
          return { ok: true, summary: `找到 ${rows.length} 个匹配`, detail }
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )
}
