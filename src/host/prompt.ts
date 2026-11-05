/**
 * Model-facing guidance installed while the Feishu tools are available.
 *
 * It exists so a mention is unambiguous: the display name is decoration, the
 * `feishu:user/…` / `feishu:chat/…` reference is the identity, and the model must
 * not claim to have read or sent anything without a tool result.
 */
export const FEISHU_REFERENCE_PROMPT = [
  'Tokens of the form @[Name](feishu:user/<open_id>) or @[Name](feishu:chat/<chat_id>) are Feishu conversations the user explicitly pointed at.',
  'The name is only a display label; the reference is the identity, so pass it through unchanged.',
  '- Reading: call feishu_read_conversation before answering anything about what was said. Never summarize a chat you did not read.',
  '- Sending: call feishu_send_message. Messages are sent as the user themself. Never claim a message was delivered without a tool result containing a message id.',
  '- Finding people: feishu_find_contact searches colleagues by name; external contacts live in groups and may only be findable through a chat member list.',
].join('\n')
