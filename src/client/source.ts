/**
 * The `@` source.
 *
 * All ranking and capping happens on the host: this file only projects host rows
 * onto menu candidates and turns a pick into an atomic reference. Keeping it thin
 * is deliberate — the composer re-queries on every keystroke, so the client must
 * stay synchronous and side-effect free.
 */
export interface MenuRow {
  kind: 'person' | 'chat' | 'search'
  name: string
  description?: string
  ref: string
  section: 'recent' | 'people' | 'chats' | 'search'
}

interface RemoteEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string } | string
}

/** What one RPC produced: a value, or the reason it failed. */
export type RpcOutcome<T> = { ok: true; value: T | undefined } | { ok: false; error: string }

const describeEnvelopeError = (envelope: RemoteEnvelope<unknown>): string => {
  const error = envelope.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : ''
    const message = typeof error.message === 'string' ? error.message : ''
    return [code, message].filter((part) => part !== '').join(': ') || 'RPC failed'
  }
  return 'RPC failed'
}

const unwrap = <T>(envelope: RemoteEnvelope<T> | T | undefined): RpcOutcome<T> => {
  if (envelope === undefined) return { ok: false, error: 'host did not answer' }
  if (typeof envelope === 'object' && envelope !== null && 'ok' in envelope) {
    const result = envelope as RemoteEnvelope<T>
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: describeEnvelopeError(result) }
  }
  return { ok: true, value: envelope as T }
}

import { rememberName } from './names'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One `/api` RPC to the host half.
 *
 * Third-party plugins reach their host through the generic `/api` channel with
 * named-argument payloads (`{ args: { … } }`); `remote.<ns>` services exist only
 * for the app's own generated namespaces.
 */
export const rpcCall = async <T>(
  ctx: any,
  method: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<RpcOutcome<T>> => {
  try {
    const rpc = ctx.get?.('connection')?.rpc
    if (rpc === undefined || typeof rpc.call !== 'function') {
      return { ok: false, error: 'connection service unavailable' }
    }
    const envelope = await rpc.call('/api', `feishu/${method}`, { args }, signal)
    return unwrap<T>(envelope)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Build the input-trigger source for the Feishu directory.
 * @param ctx - client root context (needs the `connection` RPC service).
 * @param t - locale binder for this plugin's namespace.
 */
export function buildFeishuSource(ctx: any, t: (key: string) => string): any {
  const call = <T>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    rpcCall<T>(ctx, method, args, signal)


  const adopt = (rows: MenuRow[] | undefined): MenuRow[] => {
    for (const row of rows ?? []) rememberName(row.ref, row.name)
    return rows ?? []
  }

  return {
    trigger: '@',
    name: 'feishu',
    order: 10,
    showGroupTitle: false,
    async candidates(_session: unknown, request: { query: string; signal: AbortSignal }) {
      const { query, signal } = request
      const localAnswer = await call<{ rows: MenuRow[] }>('candidates', { query }, signal)
      const local = adopt(localAnswer.ok ? localAnswer.value?.rows : undefined)
      if (signal.aborted) return []
      if (local.length > 0 || query.trim().length < 2) return local.map(toCandidate(t))

      // Nothing local: let the keystroke settle before spending one API call.
      await sleep(250)
      if (signal.aborted) return []
      const searchAnswer = await call<{ rows: MenuRow[] }>('searchCandidates', { query }, signal)
      const searched = adopt(searchAnswer.ok ? searchAnswer.value?.rows : undefined)
      if (signal.aborted) return []
      return searched.map(toCandidate(t))
    },
    onPick({ candidate }: { candidate: { value?: string } }) {
      if (candidate.value === undefined) return undefined
      let value: { ref?: string; label?: string }
      try {
        value = JSON.parse(candidate.value) as { ref?: string; label?: string }
      } catch {
        return undefined
      }
      if (value.ref === undefined || value.ref === '') return undefined
      return {
        insert: {
          source: 'feishu',
          ref: value.ref,
          label: value.label ?? value.ref,
          appearance: 'session',
          clipboardText: value.ref,
        },
      }
    },
    codec: {
      clipboardText: (ref: string) => ref,
      // Re-check at submit time: a stale contact should block the send instead of
      // silently becoming text the model cannot resolve.
      serialize: async (ref: string) => {
        const answer = await call<{ ok: boolean; message?: string; name?: string }>('validate', { ref })
        if (!answer.ok) throw new Error(answer.error)
        const checked = answer.value
        if (checked !== undefined && checked.ok === true) rememberName(ref, checked.name)
        if (checked !== undefined && checked.ok === false) {
          throw new Error(checked.message ?? '飞书引用已失效')
        }
        return ref
      },
    },
  }
}

const toCandidate = (t: (key: string) => string) => (row: MenuRow): any => ({
  name: row.name,
  ...(row.description === undefined ? {} : { description: row.description }),
  icon: 'session',
  section: t(`section.${row.section}`),
  value: JSON.stringify({ ref: row.ref, label: row.name }),
})
