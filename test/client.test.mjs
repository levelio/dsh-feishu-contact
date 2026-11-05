/**
 * Client-bundle contract test.
 *
 * The Web kernel evaluates `lib/client.js` as a classic script that must only
 * register a factory (`window.__ModuleLoader__.load`), then materializes the
 * plugin by calling `factory(require)`. This test reproduces that contract with a
 * stub module table, so a broken wrapper or a stray top-level side effect fails
 * here instead of inside the GUI.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// A Component base just good enough for the PanelBoundary class in the bundle.
class ComponentStub {
  constructor(props) {
    this.props = props
    this.state = {}
  }
  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
  }
  render() {
    return null
  }
}

/**
 * A React stub with deferred state semantics.
 *
 * Real React runs a setState *updater* during the next render — after the event
 * handler has returned and the synthetic event's `currentTarget` has been nulled.
 * The old panel read `event.currentTarget.value` inside the updater, so the very
 * first keystroke threw and unmounted the whole settings section. This stub
 * reproduces that timing: setters queue, `flush()` applies updaters and re-renders.
 */
const createHarness = () => {
  const slots = []
  const pending = []
  const effects = []
  let cursor = 0

  const react = {
    Component: ComponentStub,
    useState: (initial) => {
      const index = cursor
      const slot = (slots[index] ??= { value: typeof initial === 'function' ? initial() : initial })
      cursor += 1
      return [slot.value, (next) => pending.push({ index, next })]
    },
    // Effects are collected during render and run inside flush(), so state set
    // from an effect (the status seed) settles like it does in real React.
    useEffect: (callback) => effects.push(callback),
    useCallback: (fn) => fn,
    // Refs must be stable across renders, exactly like real React.
    useRef: (value) => {
      const slot = (slots[cursor] ??= { value })
      cursor += 1
      return slot
    },
  }
  const jsx = (type, props) => ({ type, props })
  const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }

  /** Render one element, resolving class/function components one level deep. */
  const render = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(render)
    const { type, props } = node
    if (typeof type !== 'function') return node
    if (type.prototype instanceof ComponentStub) return render(new type(props).render())
    cursor = 0
    return render(type(props))
  }

  const snapshot = () => JSON.stringify(slots.map((slot) => slot.value))

  /**
   * Apply queued updates, re-render, run the effects that render collected, and
   * repeat until the state stops changing (bounded, like an act() flush).
   */
  const flush = (rootElement) => {
    let tree = render(rootElement)
    for (let round = 0; round < 10; round += 1) {
      while (pending.length > 0) {
        const { index, next } = pending.shift()
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
      }
      const before = snapshot()
      tree = render(rootElement)
      const collected = effects.splice(0)
      for (const effect of collected) effect()
      if (snapshot() === before && pending.length === 0 && effects.length === 0) break
    }
    return tree
  }

  /** Collect elements of one tag from a rendered tree. */
  const findAll = (node, tag, found = []) => {
    if (node === null || node === undefined) return found
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, tag, found)
      return found
    }
    if (typeof node !== 'object') return found
    if (node.type === tag) found.push(node)
    findAll(node.props?.children, tag, found)
    return found
  }

  const reset = () => {
    slots.length = 0
    pending.length = 0
  }

  return { react, jsxRuntime, render, flush, findAll, reset }
}

const primitivesStub = {
  ReferenceChip: ({ appearance, label, title }) => ({ type: 'ReferenceChip', props: { appearance, label, title } }),
}

const harness = createHarness()
const reactStub = harness.react
const jsxStub = harness.jsxRuntime

const loadPlugin = () => {
  let registration
  const window = {
    __ModuleLoader__: {
      load: (value) => {
        registration = value
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', bundle)(window)
  assert.ok(registration, 'bundle registered a factory')
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return jsxStub
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { registration, exports }
}

const fakeContext = (handlers = {}) => {
  const captured = { sources: [], panels: [], rules: [], nodes: [], rpc: handlers }
  const ctx = {
    get: (key) => {
      if (key === 'inputTriggers') return { registerSource: (source) => (captured.sources.push(source), () => {}) }
      if (key === 'connection') {
        return {
          rpc: {
            call: async (channel, endpoint, payload, signal) => {
              assert.equal(channel, '/api', 'rpc goes through the /api channel')
              const method = String(endpoint).replace(/^feishu\//, '')
              const handler = handlers[method]
              if (handler === undefined) throw new Error(`unexpected rpc: ${method}`)
              return { ok: true, value: await handler(payload?.args ?? {}, signal) }
            },
          },
        }
      }
      return undefined
    },
    effect: (fn) => {
      fn()
    },
    locale: { register: () => {}, bind: () => (key) => key },
    uiConversation: { userText: { register: (rule) => (captured.rules.push(rule), () => {}) } },
    slots: {
      // The real inject accepts a generator that yields disposers per registration.
      inject: (_name, fn) => {
        const out = fn()
        const disposers = []
        if (out !== null && out !== undefined && typeof out[Symbol.iterator] === 'function') {
          for (const dispose of out) disposers.push(dispose)
        } else if (typeof out === 'function') {
          disposers.push(out)
        }
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose()
        }
      },
      register: (spec, component) => {
        if (spec.name === 'plugins.bundle.config') captured.panels.push({ spec, component })
        else captured.nodes.push({ spec, component })
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

test('the bundle registers a factory and exports the plugin face', () => {
  const { registration, exports } = loadPlugin()
  assert.equal(registration.id, 'dsh-feishu-contact')
  assert.equal(exports.name, 'dsh-feishu-contact')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(exports.inject.includes('inputTriggers'))
  assert.ok(!exports.inject.includes('remote.feishu'), 'third-party namespaces have no mounted remote.* service')
})

test('apply registers one @ source and the settings panel', () => {
  const { exports } = loadPlugin()
  const { ctx, captured } = fakeContext()
  exports.apply(ctx)

  assert.equal(captured.sources.length, 1)
  assert.equal(captured.sources[0].trigger, '@')
  assert.equal(captured.sources[0].name, 'feishu')
  assert.equal(captured.panels.length, 1)
  assert.equal(captured.panels[0].spec.name, 'plugins.bundle.config')
})

const CANDIDATE_ROWS = [
  { kind: 'person', name: '张三', description: '内部 · 刚刚', ref: 'feishu:user/ou_a', section: 'recent' },
  { kind: 'chat', name: '接口群', description: '12 人', ref: 'feishu:chat/oc_b', section: 'chats' },
]

test('candidates map host rows onto menu candidates', async () => {
  const { exports } = loadPlugin()
  const { ctx, captured } = fakeContext({ candidates: async () => ({ rows: CANDIDATE_ROWS }) })
  exports.apply(ctx)
  const rows = await captured.sources[0].candidates({ sessionId: 's' }, { query: '', signal: new AbortController().signal })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, '张三')
  assert.equal(rows[0].section, 'section.recent')
  assert.equal(rows[1].icon, 'session')
  assert.ok(JSON.parse(rows[0].value).ref.startsWith('feishu:user/'))
})

test('an empty local result falls back to the host search', async () => {
  const { exports } = loadPlugin()
  const { ctx, captured } = fakeContext({
    candidates: async () => ({ rows: [] }),
    searchCandidates: async () => ({ rows: [{ kind: 'person', name: '搜到的张三', ref: 'feishu:user/ou_c', section: 'people' }] }),
  })
  exports.apply(ctx)
  const rows = await captured.sources[0].candidates({ sessionId: 's' }, { query: '张翰', signal: new AbortController().signal })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '搜到的张三')
})

test('a pick inserts an atomic reference and the codec rejects stale ones', async () => {
  const { exports } = loadPlugin()
  const { ctx, captured } = fakeContext({
    validate: async (args) =>
      args.ref.includes('ou_gone') ? { ok: false, message: '没了' } : { ok: true, name: '张三' },
  })
  exports.apply(ctx)
  const source = captured.sources[0]

  const outcome = source.onPick({ candidate: { value: JSON.stringify({ ref: 'feishu:user/ou_a', label: '张三' }) } })
  assert.deepEqual(outcome.insert, {
    source: 'feishu',
    ref: 'feishu:user/ou_a',
    label: '张三',
    appearance: 'session',
    clipboardText: 'feishu:user/ou_a',
  })
  assert.equal(await source.codec.serialize('feishu:user/ou_a'), 'feishu:user/ou_a')
  await assert.rejects(() => source.codec.serialize('feishu:user/ou_gone'))
})

test('typing into the credentials inputs survives React event pooling', () => {
  const { exports } = loadPlugin()
  const { ctx, captured } = fakeContext()
  exports.apply(ctx)
  assert.ok(captured.panels.length > 0, 'settings panel registered')
  const panel = captured.panels[0].component
  harness.reset()

  const tree = harness.render(panel({ view: 'page' }))
  const inputs = harness.findAll(tree, 'input')
  assert.equal(inputs.length, 2, 'two credential inputs render')

  // First keystroke in App ID: the handler returns, React nulls currentTarget,
  // and only then does the state updater run.
  const event = { currentTarget: { value: 'cli_x' } }
  inputs[0].props.onChange(event)
  event.currentTarget = null
  const after = harness.flush(panel({ view: 'page' }))
  const updated = harness.findAll(after, 'input')
  assert.equal(updated[0].props.value, 'cli_x', 'App ID state updated')

  // Same for App Secret.
  const secretEvent = { currentTarget: { value: 's3cret' } }
  updated[1].props.onChange(secretEvent)
  secretEvent.currentTarget = null
  const afterSecret = harness.flush(panel({ view: 'page' }))
  const inputsAfter = harness.findAll(afterSecret, 'input')
  assert.equal(inputsAfter[1].props.value, 's3cret', 'App Secret state updated')
  assert.equal(inputsAfter[0].props.value, 'cli_x', 'App ID kept its value')
})

test('sent-message references decorate back into name chips', async () => {
  const { exports } = loadPlugin()
  const { ctx, captured } = fakeContext({
    directory: async () => ({ names: { 'feishu:user/ou_abc123456': '张三', 'feishu:chat/oc_grp': '接口群' } }),
  })
  exports.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))

  // apply() registered the matcher and the node renderer.
  assert.equal(captured.rules.length, 1)
  assert.equal(captured.rules[0].id, 'feishu')
  assert.ok(captured.nodes.some((entry) => entry.spec.key === 'feishu'))

  const rule = captured.rules[0]
  // Bare reference, the form the codec actually serializes to.
  const bare = rule.match('给 feishu:user/ou_abc123456 发个 hi', 0)
  assert.deepEqual(
    { start: bare.start, end: bare.end },
    { start: '给 '.length, end: '给 feishu:user/ou_abc123456'.length },
    'covers exactly the reference',
  )
  assert.equal(bare.data.label, '张三', 'label resolved from the directory')

  // Markdown form pasted from elsewhere.
  const markdown = rule.match('问下 @[李四](feishu:user/ou_li4444444) 这个方案', 0)
  assert.equal(markdown.data.label, '李四', 'captured markdown label wins when the id is unknown')

  // Unknown reference degrades to a shortened id instead of breaking.
  const unknown = rule.match('给 feishu:user/ou_zzz999888777 发个 hi', 0)
  assert.match(unknown.data.label, /^用户 ou_/)

  // Searching starts at the given offset.
  const twice = 'feishu:chat/oc_grp 和 feishu:user/ou_abc123456'
  const first = rule.match(twice, 0)
  const second = rule.match(twice, first.end)
  assert.equal(first.data.label, '接口群')
  assert.equal(second.data.label, '张三')

  // The renderer turns one node into a session-styled chip.
  const node = harness.render(
    exports.FeishuMentionNode({ node: { data: bare.data }, raw: 'feishu:user/ou_abc123456' }),
  )
  const chip = harness.findAll(node, 'ReferenceChip')[0]
  assert.deepEqual(
    { appearance: chip.props.appearance, label: chip.props.label },
    { appearance: 'session', label: '张三' },
  )
})

test('message settings section reflects status and saves through applySettings', async () => {
  const { exports } = loadPlugin()
  const calls = []
  const { ctx, captured } = fakeContext({
    authStatus: async () => ({
      configured: true,
      redirectUri: 'http://localhost:3000/callback',
      authorized: true,
      pending: false,
      messageFormat: 'text',
      footer: true,
      footerText: '由小助手转发',
    }),
    applySettings: async (args) => {
      calls.push(args)
      return { ok: true, configured: true }
    },
  })
  exports.apply(ctx)
  harness.reset()
  const panel = captured.panels[0].component
  // First flush runs the mount effect, which fires the authStatus RPC; the
  // promise settles after it returns, so a second flush applies the status and
  // runs the seed effect — the same two frames real React goes through.
  harness.flush(panel({ view: 'page' }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = harness.flush(panel({ view: 'page' }))

  // `t` is the identity in this harness, so buttons carry their locale keys.
  const buttons = harness.findAll(tree, 'button').map((node) => node.props.children)
  assert.ok(buttons.includes('msg.formatCard'), 'card option rendered')
  assert.ok(buttons.includes('msg.formatText'), 'text option rendered')
  // The status says text, so the text option is the active (primary) one.
  const formatButtons = harness
    .findAll(tree, 'button')
    .filter((node) => node.props.children === 'msg.formatCard' || node.props.children === 'msg.formatText')
  const active = formatButtons.find((node) => node.props.style?.background === '#3370ff')
  assert.equal(active?.props.children, 'msg.formatText', 'text is selected per status')
  // Switching to card updates local state (event arguments, no footer controls left).
  const cardButton = formatButtons.find((node) => node.props.children === 'msg.formatCard')
  cardButton.props.onClick()
  const switched = harness.flush(panel({ view: 'page' }))
  const switchedButtons = harness
    .findAll(switched, 'button')
    .filter((node) => node.props.children === 'msg.formatCard' || node.props.children === 'msg.formatText')
  assert.equal(
    switchedButtons.find((node) => node.props.style?.background === '#3370ff')?.props.children,
    'msg.formatCard',
    'clicking card selects it',
  )
})

test('a stored secret shows as a mask and is not re-sent untouched', async () => {
  const { exports } = loadPlugin()
  const calls = []
  const { ctx, captured } = fakeContext({
    authStatus: async () => ({
      configured: true,
      redirectUri: 'http://localhost:3000/callback',
      authorized: true,
      pending: false,
      appId: 'cli_stored',
      appSecretMask: 'abc*******',
      messageFormat: 'card',
    }),
    applySettings: async (args) => {
      calls.push(args)
      return { ok: true, configured: true }
    },
  })
  exports.apply(ctx)
  harness.reset()
  const panel = captured.panels[0].component
  harness.flush(panel({ view: 'page' }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = harness.flush(panel({ view: 'page' }))

  const inputs = harness.findAll(tree, 'input')
  assert.deepEqual(
    inputs.map((node) => node.props.value),
    ['cli_stored', 'abc*******'],
    'both fields are prefilled, the secret as a mask',
  )

  const save = harness.findAll(tree, 'button').find((node) => node.props.children === 'config.save')
  assert.ok(save !== undefined, 'save button rendered')
  await save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls.at(-1), { appId: 'cli_stored' }, 'untouched mask is not sent as the secret')

  // Typing a real secret replaces it: only then is appSecret sent.
  const secretInput = harness.findAll(tree, 'input')[1]
  const event = { currentTarget: { value: 'brand-new-secret' } }
  secretInput.props.onChange(event)
  event.currentTarget = null
  const typed = harness.flush(panel({ view: 'page' }))
  const saveTyped = harness.findAll(typed, 'button').find((node) => node.props.children === 'config.save')
  await saveTyped.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls.at(-1), { appId: 'cli_stored', appSecret: 'brand-new-secret' })
})
