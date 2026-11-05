/**
 * Transcript decoration for Feishu references.
 *
 * Sent messages carry the reference the model needs (`feishu:user/ou_…`), which
 * is precise and unreadable. This module turns every occurrence back into a chip
 * labeled with the person or group name, using the same
 * `conversation.user.text.node` surface the shipped `@file`/`@session` chips use.
 *
 * The text matcher must resolve labels synchronously, so names come from a local
 * cache that `candidates` responses, picks, and a one-shot `directory` fetch keep
 * warm; an unknown reference degrades to a shortened id instead of blocking.
 */
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import { labelOfRef } from './names'

/** Markdown mention `@[label](feishu:…)` or the bare reference form. */
const MENTION = /(@\[([^\]\n]*)\]\((feishu:(?:user|chat)\/[A-Za-z0-9_-]+)\))|(feishu:(?:user|chat)\/[A-Za-z0-9_-]+)/g

/** Registered with `ctx.uiConversation.userText`. */
export const feishuMentionRule = {
  id: 'feishu',
  // Below the shipped file rule (30) so the markdown form wins its own overlap:
  // `@[张三](feishu:…)` also matches the file rule's `@[^\s]+` token.
  order: 10,
  match(text: string, from: number) {
    MENTION.lastIndex = from
    for (let match = MENTION.exec(text); match !== null; match = MENTION.exec(text)) {
      const ref = match[3] ?? match[4]
      if (ref === undefined || ref === '') continue
      const capturedLabel = match[3] !== undefined ? match[2] : undefined
      return {
        id: 'feishu',
        start: match.index,
        end: match.index + match[0].length,
        data: { ref, label: labelOfRef(ref, capturedLabel) },
      }
    }
    return undefined
  },
}

/** One decorated occurrence: a session-styled chip carrying the resolved name. */
export function FeishuMentionNode({
  node,
  raw,
}: {
  node: { data: { ref: string; label: string } }
  raw?: string
}) {
  return <ReferenceChip appearance="session" label={node.data.label} title={raw ?? node.data.ref} />
}
