/**
 * Plugin configuration: the schema the settings page renders, plus the
 * normalization that turns stored strings into the values the runtime uses.
 */
import { CHAT_CACHE_TTL_MS, DEFAULT_REDIRECT_PORT, DEFAULT_STATE_FILE, DEFAULT_TOKEN_FILE } from './constants.js'

export type ShowChats = 'auto' | 'on' | 'off'
export type MessageFormat = 'card' | 'text'

export interface PluginConfig {
  tokenFile: string
  stateFile: string
  appId: string
  appSecret: string
  redirectPort: number
  showChats: ShowChats
  messageFormat: MessageFormat
  requireApproval: boolean
  defaultLimit: number
  cacheTtlMs: number
  autoRefresh: boolean
  /**
   * Optional one-time contact import: a JSON file shaped like
   * `{ people: [{ name, open_id, type?, en_name? }] }`. Empty means "keep the
   * directory empty and build it from groups and searches".
   */
  contactsSeedFile: string
}

export const DEFAULT_CONFIG: PluginConfig = {
  tokenFile: DEFAULT_TOKEN_FILE,
  stateFile: DEFAULT_STATE_FILE,
  appId: '',
  appSecret: '',
  redirectPort: DEFAULT_REDIRECT_PORT,
  showChats: 'auto',
  messageFormat: 'card',
  requireApproval: false,
  defaultLimit: 30,
  cacheTtlMs: CHAT_CACHE_TTL_MS,
  autoRefresh: true,
  contactsSeedFile: '',
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

/** Normalize whatever the loader stored into a complete config. */
export function normalizeConfig(raw: Partial<PluginConfig> | undefined): PluginConfig {
  const config = raw ?? {}
  const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  return {
    tokenFile: text(config.tokenFile, DEFAULT_CONFIG.tokenFile),
    stateFile: text(config.stateFile, DEFAULT_CONFIG.stateFile),
    appId: text(config.appId, ''),
    appSecret: text(config.appSecret, ''),
    redirectPort: clampInt(config.redirectPort, DEFAULT_CONFIG.redirectPort, 1024, 65535),
    showChats: pick(config.showChats, ['auto', 'on', 'off'] as const, 'auto'),
    messageFormat: pick(config.messageFormat, ['card', 'text'] as const, 'card'),
    requireApproval: config.requireApproval === true,
    defaultLimit: clampInt(config.defaultLimit, DEFAULT_CONFIG.defaultLimit, 1, 200),
    cacheTtlMs: clampInt(config.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 10_000, 24 * 60 * 60 * 1000),
    autoRefresh: config.autoRefresh !== false,
    contactsSeedFile: text(config.contactsSeedFile, ''),
  }
}

/** Whether the chat list may be shown at all (`auto` still needs a non-empty list). */
export function chatsAllowed(config: PluginConfig): boolean {
  return config.showChats !== 'off'
}

/** Whether a non-empty chat list is required before the group section appears. */
export function chatsAuto(config: PluginConfig): boolean {
  return config.showChats === 'auto'
}
