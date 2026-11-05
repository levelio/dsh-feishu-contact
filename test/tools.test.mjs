/**
 * Tool-definition validation against the real registry package.
 *
 * `defineTool` validates its `output.schema` against the tool value-schema DSL,
 * not raw JSON Schema. A definition the DSL rejects throws at registration time,
 * and because registration happens inside one `ctx.inject` callback the throw
 * removes *every* tool of the plugin silently — the model then sees no Feishu
 * tools at all and improvises with bash. These tests are the guard for that.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { registerFeishuTools } = await import('../lib/host/tools.js')

const runtime = {
  config: { defaultLimit: 30, requireApproval: false },
  resolveTarget: async () => ({ kind: 'person', id: 'ou_a', name: '张三' }),
  readConversation: async () => ({ target: { kind: 'person', id: 'ou_a', name: '张三' }, transcript: 'hi', count: 1, truncated: false }),
  sendMessage: async () => ({ target: { kind: 'person', id: 'ou_a', name: '张三' }, messageId: 'om_1', chatId: 'oc_1' }),
  findContacts: async () => [],
  requestApproval: async () => true,
}

const register = () => {
  const registered = []
  registerFeishuTools({ tools: { register: (tool) => (registered.push(tool), () => {}) } }, runtime)
  return registered
}

test('every tool registers against the real registry DSL', () => {
  const tools = register()
  assert.equal(tools.length, 3)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'feishu_find_contact',
    'feishu_read_conversation',
    'feishu_send_message',
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.output.render, 'function', `${tool.name} declares a renderer`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name} output is object-rooted`)
    assert.equal(tool.output.schema.additionalProperties, false, `${tool.name} states its openness`)
    assert.ok(tool.parameters !== undefined, `${tool.name} declares parameters`)
  }
})

test('the send tool renders a compact, actionable result', async () => {
  const send = register().find((tool) => tool.name === 'feishu_send_message')
  const value = await send.execute({ target: 'feishu:user/ou_a', text: 'hi' }, {})
  assert.deepEqual(value, { ok: true, summary: '已发送给张三', detail: 'message_id: om_1\nchat_id: oc_1' })
  const blocks = send.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /已发送给张三/)
  assert.match(blocks[0].text, /om_1/)
})

test('a read result names the target and carries the transcript', async () => {
  const read = register().find((tool) => tool.name === 'feishu_read_conversation')
  const value = await read.execute({ target: 'feishu:user/ou_a' }, {})
  assert.equal(value.ok, true)
  assert.match(value.summary, /张三/)
  assert.equal(value.detail, 'hi')
})

test('an empty message is refused without touching the network', async () => {
  const send = register().find((tool) => tool.name === 'feishu_send_message')
  const value = await send.execute({ target: 'feishu:user/ou_a', text: '   ' }, {})
  assert.equal(value.ok, false)
  assert.equal(value.summary, '消息内容是空的')
})
