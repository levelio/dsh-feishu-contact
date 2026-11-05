/**
 * Host smoke test.
 *
 * The real Host resolves `@deepseek-ai/*` from the DSH installation, which this
 * repository cannot do. So the built host tree is copied next to minimal stubs of
 * the three packages it links against, imported as ESM exactly as the Loader
 * would, and exercised end to end against a stubbed `fetch`.
 *
 * This is the test that catches "the row silently never activates": a bad import,
 * a broken decorator, a constructor that throws, or an RPC that never answers.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const STUBS = {
  '@deepseek-ai/schemastery': `
    const Schema = new Proxy({}, {
      get: () => (..._args) => Schema,
    })
    export default Schema
  `,
  '@deepseek-ai/dsh-typert-protocol': `
    export function Remote(_name) {
      return function decorator() {}
    }
    export class TypertRemoteService {
      constructor(ctx, name) {
        this.ctx = ctx
        this.name = name
      }
    }
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool(options) {
      return options
    }
  `,
}

const buildSandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-smoke-'))
  const pkg = join(root, 'pkg')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-feishu-contact', type: 'module' }))
  cpSync(new URL('../lib/host', import.meta.url), join(pkg, 'lib/host'), { recursive: true })
  for (const [name, source] of Object.entries(STUBS)) {
    const dir = join(pkg, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
    writeFileSync(join(dir, 'index.js'), source)
  }
  return { root, entry: join(pkg, 'lib/host/index.js') }
}

/** A Context that satisfies exactly what the service touches during start-up. */
const fakeContext = () => {
  const tools = []
  const listeners = []
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: (name, handler) => {
      listeners.push({ name, handler })
      return () => {}
    },
    get: () => undefined,
    inject: (_names, callback) => {
      callback({ tools: { register: (tool) => tools.push(tool) } })
    },
    agents: { list: () => [] },
  }
  return { ctx, tools, listeners, disposers }
}

const nowSec = () => Math.floor(Date.now() / 1000)

const seedFiles = (root) => {
  const tokenFile = join(root, 'token.json')
  const stateFile = join(root, 'state.json')
  writeFileSync(
    tokenFile,
    JSON.stringify({
      access_token: 'live',
      expires_at: nowSec() + 3600,
      refresh_token: 'r1',
      refresh_expires_at: nowSec() + 86400,
      user: { open_id: 'ou_me', name: '示例用户' },
    }),
  )
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      updatedAt: 0,
      people: [
        { name: '张三', open_id: 'ou_ouyang', type: 'internal', chat_id: 'oc_direct' },
        { name: '王五', open_id: 'ou_song', type: 'external' },
      ],
      chats: [{ chat_id: 'oc_team', name: '项目对接群', member_count: 12 }],
    }),
  )
  return { tokenFile, stateFile }
}

const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

test('the host module imports, constructs, and answers its RPC surface', async () => {
  const { root, entry } = buildSandbox()
  const { tokenFile, stateFile } = seedFiles(root)
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/im/v1/chats?')) {
      return json({ code: 0, data: { items: [{ chat_id: 'oc_team', name: '项目对接群', member_count: 12 }], has_more: false } })
    }
    if (url.includes('/authen/v1/user_info')) return json({ code: 0, data: { open_id: 'ou_me', name: '示例用户' } })
    return json({ code: 0, data: {} })
  }
  try {
    const module = await import(pathToFileURL(entry).href)
    const Service = module.default
    assert.equal(typeof Service, 'function', 'default export is the service class')

    const { ctx, tools, disposers } = fakeContext()
    const service = new Service(ctx, { tokenFile, stateFile })

    assert.equal(tools.length, 3, 'three tools registered')
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['feishu_find_contact', 'feishu_read_conversation', 'feishu_send_message'],
    )

    const status = await service.authStatus()
    assert.equal(status.authorized, true)
    assert.equal(status.user.open_id, 'ou_me')

    const answer = await service.candidates('', new AbortController().signal)
    assert.ok(Array.isArray(answer.rows))
    assert.equal(answer.rows[0].name, '张三')
    assert.ok(answer.rows.some((row) => row.kind === 'chat' && row.name === '项目对接群'), 'group list reached the menu')

    const typed = await service.candidates('张', new AbortController().signal)
    assert.equal(typed.rows[0].ref, 'feishu:user/ou_ouyang')

    assert.equal((await service.validate('feishu:user/ou_ouyang')).ok, true)
    assert.equal((await service.validate('feishu:user/ou_missing')).ok, false)

    const directory = await service.directory()
    assert.equal(directory.names['feishu:user/ou_ouyang'], '张三', 'person names are addressable by ref')
    assert.equal(directory.names['feishu:chat/oc_team'], '项目对接群', 'group names are addressable by ref')

    service.dispose()
    for (const dispose of disposers) dispose()
    rmSync(root, { recursive: true, force: true })
  } finally {
    globalThis.fetch = original
  }
})

test('reading a conversation goes resolve → messages → names → transcript', async () => {
  const { root, entry } = buildSandbox()
  const { tokenFile, stateFile } = seedFiles(root)
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/im/v1/messages?')) {
      return json({
        code: 0,
        data: {
          has_more: false,
          items: [
            {
              message_id: 'om_2',
              msg_type: 'text',
              create_time: '1760000060000',
              sender: { id: 'ou_ouyang' },
              body: { content: JSON.stringify({ text: '@_user_1 这个接口什么时候上' }) },
              mentions: [{ key: '@_user_1', name: '赵六', id: 'ou_me' }],
            },
            {
              message_id: 'om_1',
              msg_type: 'text',
              create_time: '1760000000000',
              sender: { id: 'ou_me' },
              body: { content: JSON.stringify({ text: '我看下' }) },
            },
          ],
        },
      })
    }
    if (url.includes('/members')) {
      return json({ code: 0, data: { items: [{ member_id: 'ou_ouyang', name: '张三' }] } })
    }
    return json({ code: 0, data: {} })
  }
  try {
    const module = await import(pathToFileURL(entry).href)
    const { ctx } = fakeContext()
    const service = new module.default(ctx, { tokenFile, stateFile })
    const result = await service.readConversation('feishu:user/ou_ouyang', 30)

    assert.equal(result.count, 2)
    assert.match(result.transcript, /我: 我看下/, 'oldest message first')
    assert.match(result.transcript, /张三: @赵六 这个接口什么时候上/)
    assert.ok(
      result.transcript.indexOf('我看下') < result.transcript.indexOf('接口什么时候上'),
      'transcript is chronological',
    )
    service.dispose()
    rmSync(root, { recursive: true, force: true })
  } finally {
    globalThis.fetch = original
  }
})

test('sending records usage and caches the private chat id', async () => {
  const { root, entry } = buildSandbox()
  const { tokenFile, stateFile } = seedFiles(root)
  const original = globalThis.fetch
  const sentBodies = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/im/v1/messages?receive_id_type=open_id')) {
      sentBodies.push(JSON.parse(init.body))
      return json({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_resolved' } })
    }
    return json({ code: 0, data: {} })
  }
  try {
    const module = await import(pathToFileURL(entry).href)
    const { ctx } = fakeContext()
    const service = new module.default(ctx, { tokenFile, stateFile })
    const result = await service.sendMessage({ target: 'feishu:user/ou_song', text: '**你好**' })

    assert.equal(result.messageId, 'om_sent')
    const [body] = sentBodies
    assert.equal(body.msg_type, 'interactive', 'card by default')
    assert.match(body.content, /"schema":"2.0"/)
    assert.equal(service.store.person('ou_song').chat_id, 'oc_resolved')
    service.dispose()
    rmSync(root, { recursive: true, force: true })
  } finally {
    globalThis.fetch = original
  }
})

test('settings saved from the panel survive a restart and shape messages', async () => {
  const { root, entry } = buildSandbox()
  const { tokenFile, stateFile } = seedFiles(root)
  const module = await import(pathToFileURL(entry).href)
  const { ctx } = fakeContext()

  // First boot: nothing configured.
  const first = new module.default(ctx, { tokenFile, stateFile })
  assert.equal((await first.authStatus()).configured, false)

  // The panel saves credentials and message preferences as partial updates.
  const applied = await first.applySettings('cli_local', 'secret_local')
  assert.equal(applied.configured, true)
  assert.match(applied.file, /settings\.json$/)
  await first.applySettings(undefined, undefined, 'text')
  const stored = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
  assert.deepEqual(
    { appId: stored.appId, messageFormat: stored.messageFormat },
    { appId: 'cli_local', messageFormat: 'text' },
  )
  assert.equal('footer' in stored, false, 'no footer settings any more')

  // Next boot picks everything up from disk even though the profile config is empty.
  const restarted = new module.default(fakeContext().ctx, { tokenFile, stateFile })
  const status = await restarted.authStatus()
  assert.equal(status.configured, true)
  assert.equal(status.messageFormat, 'text')
  assert.equal(status.appSecretMask, 'sec*******', 'stored secret comes back masked, not in the clear')

  // The configured default is text; an explicit card request overrides it and
  // carries the custom footer, while plain text carries none.
  const sentBodies = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/im/v1/messages?receive_id_type=open_id')) {
      sentBodies.push(JSON.parse(init.body))
      return json({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_direct' } })
    }
    return json({ code: 0, data: {} })
  }
  try {
    await restarted.sendMessage({ target: 'feishu:user/ou_ouyang', text: 'plain hi' })
    await restarted.sendMessage({ target: 'feishu:user/ou_ouyang', text: 'card hi', format: 'card' })
    assert.equal(sentBodies[0].msg_type, 'text', 'configured default is text')
    assert.equal(sentBodies[1].msg_type, 'interactive', 'explicit card request overrides the default')
    assert.doesNotMatch(sentBodies[1].content, /DeepSeek Harness/, 'cards carry no footer')
  } finally {
    globalThis.fetch = original
  }

  // Chinese phrasing from the conversation normalizes too.
  assert.equal(module.normalizeMessageFormat('卡片'), 'card')
  assert.equal(module.normalizeMessageFormat('文本'), 'text')
  assert.equal(module.normalizeMessageFormat('传真'), undefined)

  first.dispose()
  restarted.dispose()
  rmSync(root, { recursive: true, force: true })
})
