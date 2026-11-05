/**
 * Host-side unit tests: the pure projections behind the menu, the message
 * renderer, and the token single-flight/lock behaviour.
 *
 * These import the built output (`lib/host/*.js`) on purpose — the build is what
 * the Host loads, so the tests exercise the emitted decorators and ESM specifiers
 * as well as the logic.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const store = await import('../lib/host/store.js')
const format = await import('../lib/host/format.js')
const token = await import('../lib/host/token.js')

const tempDir = () => mkdtempSync(join(tmpdir(), 'feishu-test-'))

const person = (name, openId, extra = {}) => ({ name, open_id: openId, type: 'internal', ...extra })
const chat = (name, chatId, extra = {}) => ({ chat_id: chatId, name, ...extra })

const seed = (file, people, chats = []) => {
  writeFileSync(file, JSON.stringify({ version: 1, people, chats, updatedAt: 0 }))
}

test('refs round-trip between canonical form and parsing', () => {
  assert.equal(store.personRef('ou_1'), 'feishu:user/ou_1')
  assert.equal(store.chatRef('oc_1'), 'feishu:chat/oc_1')
  assert.deepEqual(store.parseRef('feishu:user/ou_1'), { kind: 'person', id: 'ou_1' })
  assert.deepEqual(store.parseRef('feishu:chat/oc_1'), { kind: 'chat', id: 'oc_1' })
  assert.equal(store.parseRef('feishu:user/'), undefined)
  assert.equal(store.parseRef('ou_1'), undefined)
})

test('empty query rolls up recent, then people, then active groups, deduped', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  const people = [
    person('甲', 'ou_a', { lastUsedAt: 1_000 }),
    person('乙', 'ou_b', { lastUsedAt: 3_000 }),
    ...Array.from({ length: 20 }, (_, index) => person(`人${index}`, `ou_p${index}`)),
  ]
  const chats = Array.from({ length: 12 }, (_, index) => chat(`群${index}`, `oc_c${index}`, { member_count: index + 2 }))
  seed(file, people, chats)
  const state = new store.StateStore(file)

  const rows = state.rows('', { showChats: true })
  assert.ok(rows.length <= 25, `expected <=25 rows, got ${rows.length}`)

  const recent = rows.filter((row) => row.section === 'recent')
  assert.deepEqual(recent.map((row) => row.name), ['乙', '甲'], 'recent is usage-ordered')
  const peopleRows = rows.filter((row) => row.section === 'people')
  assert.ok(peopleRows.length <= 12)
  assert.ok(!peopleRows.some((row) => row.name === '甲' || row.name === '乙'), 'recent people are not repeated')
  assert.equal(rows.filter((row) => row.section === 'chats').length, 5, 'groups cap at five')
  rmSync(dir, { recursive: true, force: true })
})

test('a typed query filters both sections and caps each at eight', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  const people = Array.from({ length: 12 }, (_, index) => person(`学生${index}`, `ou_${index}`))
  const chats = Array.from({ length: 12 }, (_, index) => chat(`学生端群${index}`, `oc_${index}`, { member_count: 3 }))
  seed(file, people, chats)
  const state = new store.StateStore(file)

  const rows = state.rows('学生', { showChats: true, peopleLimit: 8, chatLimit: 8 })
  assert.equal(rows.filter((row) => row.kind === 'person').length, 8)
  assert.equal(rows.filter((row) => row.kind === 'chat').length, 8)
  assert.ok(rows.every((row) => row.name.includes('学生')))
  rmSync(dir, { recursive: true, force: true })
})

test('groups disappear when disabled or unavailable', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  seed(file, [person('甲', 'ou_a')], [chat('群', 'oc_1')])
  const state = new store.StateStore(file)

  assert.equal(state.rows('', { showChats: false }).filter((row) => row.kind === 'chat').length, 0)
  assert.equal(state.rows('', { showChats: true }).filter((row) => row.kind === 'chat').length, 1)

  const empty = new store.StateStore(join(dir, 'missing.json'))
  assert.equal(empty.rows('', { showChats: true }).filter((row) => row.kind === 'chat').length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('the server-search fallback only appears for a two-character miss', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  seed(file, [person('张三', 'ou_zhang')])
  const state = new store.StateStore(file)

  assert.equal(state.rows('张', { showChats: false })[0].name, '张三')
  assert.equal(state.rows('欧', { showChats: false }).length, 0, 'single character never spends a search')
  const miss = state.rows('钱八', { showChats: false })
  assert.equal(miss.length, 1)
  assert.equal(miss[0].kind, 'search')
  assert.equal(miss[0].search, '钱八')
  rmSync(dir, { recursive: true, force: true })
})

test('a leading # narrows to groups only', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  seed(file, [person('群助手', 'ou_a')], [chat('接口群', 'oc_1')])
  const state = new store.StateStore(file)
  const rows = state.rows('#接口', { showChats: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'chat')
  rmSync(dir, { recursive: true, force: true })
})

test('usage recording persists and promotes a person into recent', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  seed(file, [person('甲', 'ou_a')])
  const state = new store.StateStore(file)
  state.touchPerson('ou_a', { chat_id: 'oc_private' })

  const reloaded = new store.StateStore(file)
  const rows = reloaded.rows('', { showChats: false })
  assert.equal(rows[0].section, 'recent')
  assert.equal(reloaded.person('ou_a').chat_id, 'oc_private')
  rmSync(dir, { recursive: true, force: true })
})

test('mentions are rewritten through mentions[], not by regex on <at>', () => {
  const message = {
    message_id: 'om_1',
    msg_type: 'text',
    create_time: '1760000000000',
    body: { content: JSON.stringify({ text: '@_user_1 看一下这个' }) },
    mentions: [{ key: '@_user_1', name: '张三', id: 'ou_x' }],
  }
  assert.equal(format.messageText(message), '@张三 看一下这个')
})

test('conversation rendering marks the authorized person as 我', () => {
  const messages = [
    {
      message_id: '1',
      msg_type: 'text',
      create_time: '1760000000000',
      sender: { id: 'ou_me' },
      body: { content: JSON.stringify({ text: '稍等' }) },
    },
    {
      message_id: '2',
      msg_type: 'text',
      create_time: '1760000060000',
      sender: { id: 'ou_them' },
      body: { content: JSON.stringify({ text: '好的\n麻烦了' }) },
    },
  ]
  const rendered = format.renderConversation(messages, new Map([['ou_them', '张三']]), 'ou_me')
  assert.match(rendered.text, /我: 稍等/)
  assert.match(rendered.text, /张三: 好的\n {4}麻烦了/)
})

test('card content wraps the body with no extra elements', () => {
  const card = JSON.parse(format.buildCardContent('**hi**'))
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: '**hi**' }])
})

test('expiry uses a forward skew and toTokenRecord keeps the refresh chain', () => {
  const now = token.nowSec()
  assert.equal(token.isExpired({ access_token: 'a', expires_at: now + 600 }), false)
  assert.equal(token.isExpired({ access_token: 'a', expires_at: now + 30 }), true)
  assert.equal(token.isExpired(undefined), true)

  const first = token.toTokenRecord({ access_token: 'a1', expires_in: 7200, refresh_token: 'r1', refresh_token_expires_in: 604800 })
  assert.equal(first.refresh_token, 'r1')
  const second = token.toTokenRecord({ access_token: 'a2', expires_in: 7200 }, first)
  assert.equal(second.refresh_token, 'r1', 'a refresh response without a new token reuses the old one')
})

test('concurrent refreshes collapse into one network call', async () => {
  const dir = tempDir()
  const file = join(dir, 'token.json')
  token.writeTokenFile(file, { access_token: 'old', expires_at: token.nowSec() - 10, refresh_token: 'r0', refresh_expires_at: token.nowSec() + 3600 })

  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ access_token: 'new', expires_in: 7200, refresh_token: 'r1', refresh_token_expires_in: 604800 }))
  }
  try {
    const manager = new token.TokenManager({ file, appId: 'id', appSecret: 'secret' })
    const results = await Promise.all([manager.accessToken(), manager.accessToken(), manager.refresh()])
    assert.deepEqual(results.slice(0, 2), ['new', 'new'])
    assert.equal(results[2].access_token, 'new')
    assert.equal(calls, 1, 'one refresh for three callers')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).refresh_token, 'r1')
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second process sees the rotated token instead of refreshing again', async () => {
  const dir = tempDir()
  const file = join(dir, 'token.json')
  token.writeTokenFile(file, { access_token: 'old', expires_at: token.nowSec() - 10, refresh_token: 'r0', refresh_expires_at: token.nowSec() + 3600 })

  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({ access_token: 'new', expires_in: 7200, refresh_token: 'r1', refresh_token_expires_in: 604800 }))
  }
  try {
    const first = new token.TokenManager({ file, appId: 'id', appSecret: 'secret' })
    await first.accessToken()
    // A "second process": fresh manager, file already rotated by the first.
    const second = new token.TokenManager({ file, appId: 'id', appSecret: 'secret' })
    const access = await second.accessToken()
    assert.equal(access, 'new')
    assert.equal(calls, 1, 'the re-read under the lock avoided a second refresh')
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the lock refuses a second holder until it is released', () => {
  const dir = tempDir()
  const file = join(dir, 'token.json')
  const release = token.acquireLock(file, { timeoutMs: 120, staleMs: 5_000 })
  try {
    assert.throws(() => token.acquireLock(file, { timeoutMs: 150, staleMs: 5_000 }), /lock/)
  } finally {
    release()
  }
  const again = token.acquireLock(file, { timeoutMs: 100 })
  again()
  rmSync(dir, { recursive: true, force: true })
})

test('an expired refresh token produces an actionable error instead of a network call', async () => {
  const dir = tempDir()
  const file = join(dir, 'token.json')
  token.writeTokenFile(file, { access_token: 'old', expires_at: token.nowSec() - 10, refresh_token: 'r0', refresh_expires_at: token.nowSec() - 5 })
  const manager = new token.TokenManager({ file, appId: 'id', appSecret: 'secret' })
  await assert.rejects(() => manager.accessToken(), /刷新凭证已过期/)
  rmSync(dir, { recursive: true, force: true })
})

test('a missing authorization file reports no-token', async () => {
  const dir = tempDir()
  const manager = new token.TokenManager({ file: join(dir, 'absent.json'), appId: 'id', appSecret: 'secret' })
  await assert.rejects(() => manager.accessToken(), /没有飞书授权/)
  rmSync(dir, { recursive: true, force: true })
})

test('the optional contact seed imports once and never duplicates', () => {
  const dir = tempDir()
  const source = join(dir, 'seed.json')
  const file = join(dir, 'state.json')
  writeFileSync(source, JSON.stringify({
    people: [
      { name: '张三', open_id: 'ou_a', type: 'internal' },
      { name: '王五', open_id: 'ou_b', type: 'external' },
      { name: '张三', open_id: 'ou_a' },
    ],
  }))
  const state = new store.StateStore(file)
  assert.equal(state.seedFromFile(source), 2, 'duplicates collapse')
  assert.equal(state.seedFromFile(source), 0, 'second import adds nothing')
  assert.equal(state.people.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('a missing seed file is not an error', () => {
  const dir = tempDir()
  const state = new store.StateStore(join(dir, 'state.json'))
  assert.equal(state.seedFromFile(join(dir, 'absent.json')), 0)
  assert.equal(state.people.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('pinyin, initials, and fuzzy spellings all reach the right contact', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  seed(
    file,
    [
      person('张三', 'ou_zhang'),
      person('李四', 'ou_li', { lastUsedAt: Date.now() }),
      person('孙七', 'ou_sun', { en_name: 'Sun Qi' }),
    ],
    [chat('项目对接群', 'oc_group', { member_count: 12 })],
  )
  const state = new store.StateStore(file)
  const names = (query) => state.rows(query, { showChats: true }).map((row) => row.name)

  assert.equal(names('zs')[0], '张三', 'initials')
  assert.equal(names('zhangsan')[0], '张三', 'full pinyin')
  assert.equal(names('zhangs')[0], '张三', 'prefix of full pinyin')
  assert.equal(names('ls')[0], '李四', 'initials of a two-character name')
  assert.equal(names('li')[0], '李四', 'short prefix')
  assert.equal(names('sunqi')[0], '孙七', 'latin pinyin of a CJK name')
  assert.equal(names('xmdj')[0], '项目对接群', 'group initials')
  assert.deepEqual(names('qqqq'), ['搜索飞书用户「qqqq」'], 'a real miss still offers the server search')
  assert.equal(state.rows('zs', { showChats: true })[0].ref, 'feishu:user/ou_zhang', 'the pick inserts the right identity')
  rmSync(dir, { recursive: true, force: true })
})

test('a pinyin hit outranks a more recently used contact', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  seed(file, [
    person('张三', 'ou_zhang'),
    person('李四', 'ou_li', { lastUsedAt: Date.now() + 10_000 }),
  ])
  const state = new store.StateStore(file)
  const rows = state.rows('zs', { showChats: false })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '张三')
  rmSync(dir, { recursive: true, force: true })
})

test('a stored secret is previewed as three characters plus a mask', () => {
  assert.equal(format.maskSecret('abc1234567890abcdef1234567890abc'), 'abc*******')
  assert.equal(format.maskSecret(''), '')
  // Never longer than the fixed mask, so the preview leaks no length either.
  assert.equal(format.maskSecret('ab').length, 'ab*******'.length)
})
