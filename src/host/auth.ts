/**
 * Interactive authorization: the OAuth v3 flow, run from the host process so the
 * settings page can offer one button.
 *
 * The redirect URI is fixed by the Feishu console (`http://localhost:3000/callback`),
 * which is why the port is not a free choice and a busy port is reported as a
 * distinct failure instead of a generic error.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { API, AUTHORIZE_URL, CALLBACK_PATH, FeishuError } from './constants.js'
import { exchangeToken, toTokenRecord, writeTokenFile, type TokenRecord } from './token.js'

const AUTH_TIMEOUT_MS = 5 * 60 * 1000

const SUCCESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title>
<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#f6f7f9;color:#1f2329}
main{text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#646a73}</style></head>
<body><main><h1>✅ 授权成功</h1><p>请回到 DeepSeek Harness，这个窗口可以关掉了。</p></main></body></html>`

const FAILURE_HTML = (reason: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权失败</title>
<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#f6f7f9;color:#1f2329}
main{text-align:center;max-width:520px}h1{font-size:20px;margin:0 0 8px}p{color:#646a73;word-break:break-word}</style></head>
<body><main><h1>授权失败</h1><p>${reason}</p></main></body></html>`

/** Open one URL in the user's default browser; failure is not fatal (the URL is shown too). */
function openBrowser(url: string): void {
  try {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // the settings page also renders the URL for manual opening
  }
}

export class AuthFlow {
  private server: Server | null = null
  private completion: Promise<TokenRecord> | null = null
  private pending: {
    state: string
    resolve: (record: TokenRecord) => void
    reject: (error: unknown) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(
    private readonly options: {
      appId?: string
      appSecret?: string
      /** Resolved per attempt so a settings change applies without a reload. */
      credentials?: () => { appId: string; appSecret: string }
      port: number
      tokenFile: string
      log?: (message: string) => void
    },
  ) {}

  get isPending(): boolean {
    return this.pending !== null
  }

  /** App credentials for this attempt, read at call time. */
  private credentials(): { appId: string; appSecret: string } {
    if (this.options.credentials !== undefined) return this.options.credentials()
    return { appId: this.options.appId ?? '', appSecret: this.options.appSecret ?? '' }
  }

  /**
   * Start one authorization attempt.
   * @returns the authorize URL to show, and opens the browser on a best-effort basis.
   */
  async begin(): Promise<{ url: string; port: number }> {
    const { appId, appSecret } = this.credentials()
    if (appId === '' || appSecret === '') {
      throw new FeishuError(
        'unsupported',
        '还没有配置飞书应用：先在设置里填 App ID / App Secret（飞书开放平台 → 创建自建应用 → 凭证与基础信息），并把重定向地址登记为 http://localhost:' +
          `${this.options.port}${CALLBACK_PATH}`,
      )
    }
    if (this.pending !== null) {
      this.pending.reject(new FeishuError('api', '新的授权请求取代了上一次'))
      this.pending = null
    }
    await this.ensureServer()
    const state = randomBytes(16).toString('base64url')
    const redirect = `http://localhost:${this.options.port}${CALLBACK_PATH}`
    const url =
      `${AUTHORIZE_URL}?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&response_type=code&scope=offline_access&state=${state}`
    let resolveFn: (record: TokenRecord) => void = () => {}
    let rejectFn: (error: unknown) => void = () => {}
    const completion = new Promise<TokenRecord>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    // The settings panel observes the outcome through authStatus(); nobody has to
    // hold this promise, so swallow a rejection that no awaiter is left to see.
    completion.catch(() => {})
    this.completion = completion
    this.pending = {
      state,
      resolve: resolveFn,
      reject: rejectFn,
      timer: setTimeout(() => {
        this.fail(new FeishuError('api', '授权超时（5 分钟）'))
      }, AUTH_TIMEOUT_MS),
    }
    openBrowser(url)
    return { url, port: this.options.port }
  }

  /** Await the outcome of the attempt started by {@link begin}. */
  wait(): Promise<TokenRecord> {
    return this.completion ?? Promise.reject(new FeishuError('api', '没有进行中的授权'))
  }

  dispose(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending.timer)
      this.pending.reject(new FeishuError('api', '插件已停止'))
      this.pending = null
    }
    this.closeServer()
  }

  private closeServer(): void {
    const server = this.server
    this.server = null
    if (server !== null) {
      try {
        server.close()
      } catch {
        // already closed
      }
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.server !== null) return
    const server = createServer((request, response) => {
      void this.handle(request.url ?? '', response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        if (error.code === 'EADDRINUSE') {
          reject(new FeishuError('port-busy', `端口 ${this.options.port} 已被占用`))
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port, '127.0.0.1')
    })
    this.server = server
  }

  private async handle(rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(rawUrl, 'http://localhost')
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end('not found')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code === null || this.pending === null || state !== this.pending.state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_HTML('回调参数不匹配，请重新发起授权'))
      this.fail(new FeishuError('api', '回调 state 不匹配'))
      return
    }
    const pending = this.pending
    try {
      const redirect = `http://localhost:${this.options.port}${CALLBACK_PATH}`
      const { appId, appSecret } = this.credentials()
      const data = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: redirect }, appId, appSecret)
      const record = toTokenRecord(data)
      record.user = await this.fetchSelf(record.access_token)
      writeTokenFile(this.options.tokenFile, record)
      this.options.log?.('feishu: authorized from settings')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML)
      this.pending = null
      clearTimeout(pending.timer)
      pending.resolve(record)
      this.closeServer()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_HTML(message))
      this.fail(error instanceof Error ? error : new Error(message))
    }
  }

  private fail(error: unknown): void {
    const pending = this.pending
    this.pending = null
    if (pending === null) return
    clearTimeout(pending.timer)
    pending.reject(error)
    this.closeServer()
  }

  private async fetchSelf(accessToken: string): Promise<TokenRecord['user']> {
    try {
      const response = await fetch(`${API}/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const payload = (await response.json()) as { code?: number; data?: { open_id?: string; name?: string; avatar_url?: string } }
      if (payload.code !== 0 || payload.data === undefined) return undefined
      const { open_id: openId, name, avatar_url: avatarUrl } = payload.data
      return { ...(openId === undefined ? {} : { open_id: openId }), ...(name === undefined ? {} : { name }), ...(avatarUrl === undefined ? {} : { avatar_url: avatarUrl }) }
    } catch {
      return undefined
    }
  }
}
