/**
 * Reference → display name cache.
 *
 * The transcript matcher resolves labels synchronously (the render path must not
 * await), so names live here. Every source that already knows a name feeds the
 * cache: `candidates` rows, picks, submit-time validation, and a one-shot
 * `directory` fetch when the plugin loads.
 */
const names = new Map<string, string>()

/** Remember one reference → display name. */
export function rememberName(ref: string, name: string | undefined): void {
  if (typeof ref !== 'string' || ref === '' || typeof name !== 'string' || name === '') return
  names.set(ref, name)
}

/** Remember a batch of `{ ref → name }`. */
export function rememberNames(batch: Record<string, string> | undefined): void {
  if (batch === undefined || batch === null) return
  for (const [ref, name] of Object.entries(batch)) rememberName(ref, name)
}

/** Drop the cache (tests). */
export function resetNames(): void {
  names.clear()
}

const shorten = (id: string): string => (id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`)

/**
 * The synchronous label for one reference.
 * @param ref - `feishu:user/ou_…` or `feishu:chat/oc_…`.
 * @param fallback - label captured from a markdown mention, when present.
 */
export function labelOfRef(ref: string, fallback?: string): string {
  const cached = names.get(ref)
  if (cached !== undefined) return cached
  if (fallback !== undefined && fallback !== '') return fallback
  const id = ref.startsWith('feishu:') ? ref.slice('feishu:'.length) : ref
  const kind = id.startsWith('user/') ? '用户 ' : id.startsWith('chat/') ? '群 ' : ''
  const bare = id.replace(/^(?:user|chat)\//, '')
  return `${kind}${shorten(bare)}`
}

/** Test/inspection hook. */
export function knownNames(): ReadonlyMap<string, string> {
  return names
}
