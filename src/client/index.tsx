/**
 * Browser half of the Feishu contact plugin.
 *
 * Registers one `@` trigger source (grouped rows, atomic references) and the
 * settings panel that owns authorization. Everything else — contacts, ranking,
 * REST calls, tokens — stays in the host process.
 */
import { Component, type ReactNode } from 'react'
import { SettingsPanel } from './ConfigPanel'
import { buildFeishuSource, rpcCall } from './source'
import { feishuMentionRule, FeishuMentionNode } from './mention'
import { rememberNames } from './names'
import { en, NS, zh } from './locales'

export const name = 'dsh-feishu-contact'

export const inject = ['inputTriggers', 'locale', 'slots', 'uiConversation']

// Re-exported for the contract tests; the loader itself only reads apply/inject/name.
export { feishuMentionRule, FeishuMentionNode }

const asDisposer = (value: unknown): (() => void) =>
  typeof value === 'function' ? (value as () => void) : () => {}

/**
 * Error boundary around the settings panel.
 *
 * A throw inside the panel would otherwise unwind into the plugin detail page
 * and take the whole config section with it — exactly the "the UI just
 * disappeared" failure mode. Catching here turns a crash into a visible message
 * with the error text, so it can be reported instead of guessed at.
 */
class PanelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.message}` : String(error) }
  }

  componentDidCatch(error: unknown): void {
    try {
      // eslint-disable-next-line no-console
      console.error('[dsh-feishu-contact] settings panel crashed:', error)
    } catch {
      // console may be unavailable
    }
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div style={{ border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8, padding: '10px 12px' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>飞书联系人面板出错</p>
          <p style={{ margin: 0, fontSize: 12, wordBreak: 'break-all', color: 'rgba(127,127,127,1)' }}>
            {this.state.error}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'rgba(127,127,127,1)' }}>
            刷新页面可恢复；把上面的错误文本发给维护者。
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

/** Client plugin body. */
export function apply(ctx: any): void {
  ctx.effect(() => asDisposer(ctx.locale.register(NS, { zh, en })), 'feishu-contact: dictionaries')

  const bound = (() => {
    try {
      return ctx.locale.bind(NS) as (key: string) => string
    } catch {
      return undefined
    }
  })()
  // Locale lookups must never take the panel down: fall back to the key itself.
  const t = (key: string): string => {
    try {
      const value = bound?.(key)
      return typeof value === 'string' && value !== '' ? value : key
    } catch {
      return key
    }
  }

  const source = buildFeishuSource(ctx, t)
  ctx.effect(() => asDisposer(ctx.get('inputTriggers').registerSource(source)), 'feishu-contact: @ source')

  // Sent messages keep the reference the model needs (feishu:user/ou_…); decorate
  // every occurrence back into a name chip on the same surface @file uses.
  ctx.effect(
    () => asDisposer(ctx.uiConversation?.userText?.register?.(feishuMentionRule)),
    'feishu-contact: mention rule',
  )
  ctx.effect(
    () =>
      asDisposer(
        ctx.slots.inject('conversation.user.text.node', function* () {
          yield ctx.slots.register(
            { name: 'conversation.user.text.node', key: 'feishu', priority: 100 },
            FeishuMentionNode,
          )
        }),
      ),
    'feishu-contact: mention node',
  )

  // Warm the name cache so transcript chips resolve on the first paint.
  void rpcCall<{ names: Record<string, string> }>(ctx, 'directory').then((answer) => {
    if (answer.ok) rememberNames(answer.value?.names)
  })

  ctx.effect(
    () =>
      asDisposer(
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: name }, (props: { view?: string }) =>
            props?.view === 'summary' ? t('settings.title') : (
              <PanelBoundary>
                <SettingsPanel ctx={ctx} t={t} />
              </PanelBoundary>
            ),
          ),
        ),
      ),
    'feishu-contact: settings panel',
  )
}
