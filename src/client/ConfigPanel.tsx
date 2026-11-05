/**
 * Settings panel for the Feishu plugin.
 *
 * Lives in the plugin detail page (`plugins.bundle.config` slot) and owns the
 * whole setup path: paste your own Feishu app credentials, authorize in the
 * browser, watch the token window. Colors deliberately avoid theme-specific
 * values (no white surfaces, no fixed grays for text) so the panel is legible in
 * both the light and dark GUI.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rpcCall } from './source'

interface RemoteEnvelope<T> {
  ok: boolean
  value?: T
}

interface AuthStatus {
  configured: boolean
  redirectUri: string
  authorized: boolean
  pending: boolean
  expiresAt?: number
  refreshExpiresAt?: number
  lastRefreshAt?: number
  tokenFile: string
  /** Configured app id, echoed back so the panel can prefill it. */
  appId?: string
  /** `abc*******` preview of the stored secret; the secret itself never leaves the host. */
  appSecretMask?: string
  /** Message form the panel edits. */
  messageFormat?: 'card' | 'text'
  user?: { open_id?: string; name?: string; avatar_url?: string }
  error?: string
}

interface ProbeResult {
  ok: boolean
  user?: string
  chats?: number
  people?: number
  message?: string
}

const POLL_MS = 1500
const MUTED = 'rgba(127,127,127,1)'
const LINE = 'rgba(127,127,127,0.35)'
const SURFACE = 'rgba(127,127,127,0.12)'

const style = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', lineHeight: '1.6' } as const,
  head: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between', flexWrap: 'wrap' } as const,
  button: {
    appearance: 'none',
    border: `1px solid ${LINE}`,
    background: 'transparent',
    color: 'inherit',
    borderRadius: '6px',
    padding: '5px 12px',
    fontSize: '13px',
    lineHeight: '1.4',
    cursor: 'pointer',
  } as const,
  primary: {
    appearance: 'none',
    border: '1px solid transparent',
    background: '#3370ff',
    color: '#fff',
    borderRadius: '6px',
    padding: '5px 12px',
    fontSize: '13px',
    lineHeight: '1.4',
    cursor: 'pointer',
  } as const,
  dot: (ok: boolean, pending: boolean) =>
    ({
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      display: 'inline-block',
      flex: '0 0 auto',
      background: pending ? '#f5a623' : ok ? '#2ea121' : '#d83931',
    }) as const,
  title: { fontWeight: 600, fontSize: '14px', margin: 0 } as const,
  row: { display: 'flex', gap: '8px', alignItems: 'baseline' } as const,
  label: { color: MUTED, minWidth: '86px', flex: '0 0 auto' } as const,
  value: { wordBreak: 'break-all' } as const,
  actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' } as const,
  hint: { color: MUTED, margin: 0, fontSize: '12px' } as const,
  error: { color: '#d83931', margin: 0, fontSize: '12px' } as const,
  ok: { color: '#2ea121', margin: 0, fontSize: '12px' } as const,
  section: {
    border: `1px solid ${LINE}`,
    borderRadius: '8px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  } as const,
  sectionTitle: { fontWeight: 600, margin: 0 } as const,
  field: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } as const,
  fieldLabel: { color: MUTED, minWidth: '86px', flex: '0 0 auto' } as const,
  input: {
    flex: '1 1 220px',
    minWidth: '160px',
    boxSizing: 'border-box',
    background: SURFACE,
    color: 'inherit',
    border: `1px solid ${LINE}`,
    borderRadius: '6px',
    padding: '5px 8px',
    fontSize: '13px',
  } as const,
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '12px',
    background: SURFACE,
    color: 'inherit',
    borderRadius: '4px',
    padding: '3px 6px',
    wordBreak: 'break-all',
  } as const,
  link: { color: '#3370ff', wordBreak: 'break-all', fontSize: '12px' } as const,
}

const formatTime = (seconds: number | undefined, fallback: string): string =>
  seconds === undefined ? fallback : new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })

export function SettingsPanel({ ctx, t }: { ctx: any; t: (key: string) => string }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [draft, setDraft] = useState({ appId: '', appSecret: '' })
  const [message, setMessage] = useState({ format: 'card' })
  const [saved, setSaved] = useState(false)
  const [msgSaved, setMsgSaved] = useState(false)
  const alive = useRef(true)

  // Third-party plugins reach their host half through the generic `/api` RPC
  // (`remote.feishu` services are mounted only for the app's own generated
  // namespaces; see dsh-api-remotes). Arguments are named parameters.
  const call = useCallback(
    async <T,>(method: string, args: Record<string, unknown> = {}): Promise<T | undefined> => {
      const answer = await rpcCall<T>(ctx, method, args)
      if (!answer.ok) {
        // Never hide the reason: a gateway descriptor mismatch once surfaced as
        // "host did not respond", which sent everyone hunting in the wrong place.
        setActionError(answer.error)
        return undefined
      }
      return answer.value
    },
    [ctx],
  )

  const reload = useCallback(async () => {
    const next = await call<AuthStatus>('authStatus')
    if (alive.current && next !== undefined) setStatus(next)
  }, [call])

  useEffect(() => {
    alive.current = true
    void reload()
    return () => {
      alive.current = false
    }
  }, [reload])

  // Seed the inputs once the host reports values, so polling never fights typing.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || status === null) return
    if (status.appId === undefined && status.messageFormat === undefined && status.appSecretMask === undefined) return
    seeded.current = true
    setDraft((current) => {
      const next = { ...current }
      if (next.appId === '' && typeof status.appId === 'string') next.appId = status.appId
      if (next.appSecret === '' && typeof status.appSecretMask === 'string') next.appSecret = status.appSecretMask
      return next
    })
    setMessage({ format: status.messageFormat === 'text' ? 'text' : 'card' })
  }, [status?.appId, status?.messageFormat, status?.appSecretMask])

  // Poll only while the browser side is in flight, so an idle panel costs nothing.
  useEffect(() => {
    if (status?.pending !== true) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.pending, reload])

  const saveCredentials = async () => {
    setBusy('save')
    setActionError(null)
    setSaved(false)
    try {
      // Deliberately NOT through configForms: writing the profile patch triggers a
      // composition reload that can drop this plugin mid-session. The host keeps its
      // own 0600 credentials file instead, and the running service picks the values
      // up immediately.
      const args: Record<string, unknown> = { appId: draft.appId.trim() }
      // An untouched field still shows the mask (or nothing); sending that text as
      // the secret would overwrite the real one, so it is simply omitted.
      const untouched = draft.appSecret === '' || draft.appSecret === status?.appSecretMask
      if (!untouched) args.appSecret = draft.appSecret.trim()
      const value = await call<{ ok: boolean; configured: boolean; file?: string }>('applySettings', args)
      if (value === undefined) {
        setActionError(t('config.applyFailed'))
      } else {
        setSaved(true)
        seeded.current = true
      }
      await reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const saveMessageSettings = async () => {
    setBusy('message')
    setActionError(null)
    setMsgSaved(false)
    try {
      const value = await call<{ ok: boolean }>('applySettings', { messageFormat: message.format })
      if (value === undefined) setActionError(t('config.applyFailed'))
      else {
        setMsgSaved(true)
        seeded.current = true
      }
      await reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const authorize = async () => {
    setBusy('authorize')
    setProbe(null)
    setActionError(null)
    try {
      const value = await call<{ url?: string; error?: string }>('authorize')
      if (value?.url !== undefined) setAuthUrl(value.url)
      else setActionError(value?.error ?? t('settings.testFailed'))
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const refreshNow = async () => {
    setBusy('refresh')
    setProbe(null)
    try {
      const value = await call<{ ok: boolean; message?: string }>('refreshToken')
      if (value?.ok === false) setProbe({ ok: false, message: value.message ?? t('settings.testFailed') })
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const runProbe = async () => {
    setBusy('probe')
    setProbe(null)
    try {
      const value = await call<ProbeResult>('probe')
      setProbe(value ?? { ok: false, message: t('settings.testFailed') })
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const pending = status?.pending === true
  const authorized = status?.authorized === true
  const configured = status?.configured === true
  const redirectUri = status?.redirectUri ?? 'http://localhost:3000/callback'

  return (
    <div style={style.wrap}>
      <div>
        <h3 style={style.title}>{t('settings.title')}</h3>
        <p style={style.hint}>{t('settings.description')}</p>
      </div>

      <div style={style.head}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={style.dot(authorized, pending)} />
          <span>
            {pending
              ? t('settings.pending')
              : authorized
                ? t('settings.connected')
                : configured
                  ? t('settings.disconnected')
                  : t('settings.notConfigured')}
          </span>
        </span>
        <span style={style.actions}>
          <button
            type="button"
            style={style.primary}
            onClick={() => void authorize()}
            disabled={busy !== null || !configured}
            title={configured ? undefined : t('settings.notConfigured')}
          >
            {authorized ? t('settings.reauthorize') : t('settings.authorize')}
          </button>
          <button type="button" style={style.button} onClick={() => void refreshNow()} disabled={busy !== null || pending}>
            {t('settings.refresh')}
          </button>
          <button type="button" style={style.button} onClick={() => void runProbe()} disabled={busy !== null}>
            {busy === 'probe' ? t('settings.testing') : t('settings.test')}
          </button>
        </span>
      </div>

      {!configured ? (
        <div style={style.section}>
          <p style={style.sectionTitle}>{t('setup.title')}</p>
          <p style={style.hint}>{t('setup.step1')}</p>
          <p style={style.hint}>{t('setup.step2')}</p>
          <code style={style.code}>{redirectUri}</code>
          <p style={style.hint}>{t('setup.step3')}</p>
        </div>
      ) : null}

      <div style={style.section}>
        <p style={style.sectionTitle}>{t('config.title')}</p>
        <div style={style.field}>
          <span style={style.fieldLabel}>{t('config.appId')}</span>
          <input
            style={style.input}
            value={draft.appId}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('config.appIdPlaceholder')}
            disabled={busy !== null}
            onChange={(event) => {
              // Read the input eagerly: React nulls `currentTarget` once the handler
              // returns, and the setDraft updater runs later, during the next render.
              const value = event.currentTarget.value
              setSaved(false)
              setDraft((current) => ({ ...current, appId: value }))
            }}
          />
        </div>
        <div style={style.field}>
          <span style={style.fieldLabel}>{t('config.appSecret')}</span>
          <input
            style={style.input}
            value={draft.appSecret}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('config.appSecretPlaceholder')}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              setSaved(false)
              setDraft((current) => ({ ...current, appSecret: value }))
            }}
          />
        </div>
        <div style={style.actions}>
          <button
            type="button"
            style={style.button}
            onClick={() => void saveCredentials()}
            disabled={busy !== null}
          >
            {t('config.save')}
          </button>
          {saved ? <span style={{ ...style.ok, alignSelf: 'center' }}>{t('config.saved')}</span> : null}
        </div>
        <p style={style.hint}>{t('config.hint')}</p>
      </div>

      <div style={style.section}>
        <p style={style.sectionTitle}>{t('msg.title')}</p>
        <div style={style.field}>
          <span style={style.fieldLabel}>{t('msg.format')}</span>
          <span style={style.actions}>
            <button
              type="button"
              style={message.format === 'card' ? style.primary : style.button}
              disabled={busy !== null}
              onClick={() => {
                setMsgSaved(false)
                setMessage((current) => ({ ...current, format: 'card' }))
              }}
            >
              {t('msg.formatCard')}
            </button>
            <button
              type="button"
              style={message.format === 'text' ? style.primary : style.button}
              disabled={busy !== null}
              onClick={() => {
                setMsgSaved(false)
                setMessage((current) => ({ ...current, format: 'text' }))
              }}
            >
              {t('msg.formatText')}
            </button>
          </span>
        </div>
        <div style={style.actions}>
          <button type="button" style={style.button} onClick={() => void saveMessageSettings()} disabled={busy !== null}>
            {t('msg.save')}
          </button>
          {msgSaved ? <span style={{ ...style.ok, alignSelf: 'center' }}>{t('msg.saved')}</span> : null}
        </div>
      </div>

      {status?.user?.name !== undefined ? (
        <div style={style.row}>
          <span style={style.label}>{t('settings.user')}</span>
          <span style={style.value}>
            {status.user.name}
            {status.user.open_id === undefined ? '' : ` · ${status.user.open_id}`}
          </span>
        </div>
      ) : null}

      <div style={style.row}>
        <span style={style.label}>{t('settings.accessExpires')}</span>
        <span style={style.value}>{formatTime(status?.expiresAt, t('settings.never'))}</span>
      </div>
      <div style={style.row}>
        <span style={style.label}>{t('settings.refreshExpires')}</span>
        <span style={style.value}>{formatTime(status?.refreshExpiresAt, t('settings.never'))}</span>
      </div>
      <div style={style.row}>
        <span style={style.label}>{t('settings.lastRefresh')}</span>
        <span style={style.value}>{formatTime(status?.lastRefreshAt, t('settings.never'))}</span>
      </div>
      <div style={style.row}>
        <span style={style.label}>{t('settings.file')}</span>
        <span style={{ ...style.value, color: MUTED }}>{status?.tokenFile ?? t('settings.never')}</span>
      </div>

      {authUrl !== null && pending ? (
        <p style={style.hint}>
          {t('settings.openManually')}
          <br />
          <a style={style.link} href={authUrl} target="_blank" rel="noreferrer">
            {authUrl}
          </a>
        </p>
      ) : null}

      {status?.error !== undefined && status.error !== '' ? <p style={style.error}>{status.error}</p> : null}
      {actionError !== null ? <p style={style.error}>{actionError}</p> : null}
      {probe !== null ? (
        <p style={probe.ok ? style.ok : style.error}>
          {probe.ok
            ? `${t('settings.testOk')}${probe.user === undefined ? '' : ` · ${probe.user}`}${
                probe.chats === undefined ? '' : ` · ${probe.chats} 个群 / ${probe.people ?? 0} 位联系人`
              }`
            : `${t('settings.testFailed')}${probe.message === undefined ? '' : ` · ${probe.message}`}`}
        </p>
      ) : null}
    </div>
  )
}
