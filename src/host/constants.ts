/**
 * Fixed coordinates of the Feishu side of this plugin.
 *
 * Every installation brings its own Feishu application: the plugin ships no
 * credentials and reads no other tool's authorization. The app id/secret are
 * configured in the settings page; this module only fixes the endpoints. The redirect URI is registered in the
 * Feishu console as `http://localhost:3000/callback`, which is why the port is not
 * a free choice.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** OAuth v3 authorize endpoint (accounts.feishu.cn, not open.feishu.cn). */
export const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
/** OAuth v3 token endpoint; the old v2 endpoint cannot issue user-identity tokens. */
export const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token'
/** Open API origin. */
export const API = 'https://open.feishu.cn/open-apis'

/** Callback path registered in the Feishu console. */
export const CALLBACK_PATH = '/callback'
/** Callback port; must keep matching the registered redirect URI. */
export const DEFAULT_REDIRECT_PORT = 3000

const HOME = homedir()

/** Where this plugin keeps its own authorization (mode A). */
export const DEFAULT_TOKEN_FILE = join(HOME, '.dsh/feishu-contact/user-token.json')
/** Where this plugin keeps contacts, chats and usage recency. */
export const DEFAULT_STATE_FILE = join(HOME, '.dsh/feishu-contact/state.json')

/** Refresh this long before the access token actually expires. */
export const ACCESS_SKEW_SEC = 120
/** How often the background timer looks at the token. */
export const REFRESH_TICK_MS = 10 * 60 * 1000
/** Chat list cache lifetime. */
export const CHAT_CACHE_TTL_MS = 10 * 60 * 1000
/** Chat list paging cap: 10 pages x 100 = 1000 groups, far above the ~430 in use. */
export const MAX_CHAT_PAGES = 10

/** Error codes the plugin exposes over RPC and through its tools. */
export type FeishuErrorCode =
  | 'no-token'
  | 'no-refresh-token'
  | 'refresh-expired'
  | 'exchange-failed'
  | 'lock-timeout'
  | 'port-busy'
  | 'token-expired'
  | 'not-found'
  | 'ambiguous'
  | 'api'
  | 'unsupported'

/** Structured failure shared by the RPC surface and the model-facing tools. */
export class FeishuError extends Error {
  readonly code: FeishuErrorCode

  constructor(code: FeishuErrorCode, message: string) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
  }

  /** Message a person can act on, used by the settings panel and the composer notice. */
  get hint(): string {
    switch (this.code) {
      case 'no-token':
      case 'no-refresh-token':
      case 'refresh-expired':
      case 'token-expired':
        return '飞书授权已失效，去「设置 → 插件 → 飞书联系人」点授权'
      case 'port-busy':
        return '端口 3000 被占用（可能是另一个飞书登录会话），先关掉再试'
      default:
        return this.message
    }
  }
}

/** coerce any thrown value into a FeishuError-shaped failure record. */
export function failureOf(error: unknown): { code: FeishuErrorCode; message: string } {
  if (error instanceof FeishuError) return { code: error.code, message: error.message }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'api', message }
}
