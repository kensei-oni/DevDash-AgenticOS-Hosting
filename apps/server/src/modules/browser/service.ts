import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Db } from '../../core/db.ts'
import { newToken, seal, sha256, unseal } from '../../core/crypto.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'

const NEKO = 'http://127.0.0.1:8090/browser'
const CDP_URL = (process.env.DEVDASH_BROWSER_CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '')
const IDLE_MS = 30 * 60_000
const ENV_FILE = '/etc/devdash/browser.env'

type Invite = {
  id: number; token_hash: string; token_sealed: string; label: string; can_control: number
  expires_at: number; created_by: number; created_at: number; revoked_at: number | null; creator_name: string
}

export type BrowserAiAction = {
  action: string
  detail: string
  by: string
  at: number
}

type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/**
 * The team's shared remote browser: one Chromium (neko) in Docker, started by the root helper when someone opens it
 * and stopped after 30 minutes with nobody watching. Logins and cookies persist in a volume between runs.
 *
 * Also exposes real-time Chrome DevTools Protocol (CDP on 127.0.0.1:9222) so Claude Code can navigate, click, type,
 * inspect the DOM, take screenshots, and evaluate JS in real time while team members watch live on the Browser page.
 */
export function browserService({
  db, runDir, masterKey, origin, hub, agents,
}: {
  db: Db; runDir: string; dataDir: string; masterKey: Buffer; origin: string
  hub?: Hub; agents?: AgentsService
}) {
  const q = {
    invites: db.prepare('select i.*, u.name as creator_name from browser_invites i join users u on u.id = i.created_by where i.revoked_at is null and i.expires_at > unixepoch() order by i.id desc'),
    byHash: db.prepare('select i.*, u.name as creator_name from browser_invites i join users u on u.id = i.created_by where i.token_hash = ?'),
    insert: db.prepare("insert into browser_invites (token_hash, token_sealed, label, can_control, expires_at, created_by) values (?, '', ?, ?, ?, ?) returning id"),
    sealToken: db.prepare('update browser_invites set token_sealed = ? where id = ?'),
    revoke: db.prepare('update browser_invites set revoked_at = unixepoch() where id = ?'),
    user: db.prepare('select id, username, name, email, role from users where username = ? and disabled_at is null'),
  }
  let lastSeen = 0
  let lastAiAction: BrowserAiAction | null = null
  const recentAiActions: BrowserAiAction[] = []

  if (hub) hub.authorize('browser', () => true)

  function recordAiAction(by: string, action: string, detail: string) {
    lastSeen = Date.now()
    const item: BrowserAiAction = { action, detail: detail.slice(0, 200), by, at: Date.now() }
    lastAiAction = item
    recentAiActions.unshift(item)
    if (recentAiActions.length > 25) recentAiActions.pop()
    hub?.publish('browser', { type: 'ai_action', ...item })
  }

  /** The bundled neko client only signs in with neko's multiuser mode: members get the admin profile, guests the watch-only one. */
  const secret = (key: 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD' | 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD') => {
    const v = readFileSync(ENV_FILE, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]
    if (!v) throw new AppError(409, 'browser', 'The browser is not set up yet. Try again in a moment.')
    return v
  }

  async function helper<T = Record<string, unknown>>(cmd: string): Promise<T> {
    if (!runDir) throw new AppError(409, 'no_host', 'The browser container needs DevDash running on its Linux server (or a local Chromium listening on CDP port 9222).')
    const r = await requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd }, 180_000)
    if (!r.ok) throw new AppError(409, 'browser', r.error?.replace(/^refused: /, '') ?? 'The browser could not start.')
    return r
  }
  const apiToken = () => {
    try { return readFileSync(ENV_FILE, 'utf8').match(/^NEKO_SESSION_API_TOKEN=(.+)$/m)?.[1] ?? '' } catch { return '' }
  }

  async function cdpTargets(): Promise<CdpTarget[]> {
    try {
      const res = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(2500) })
      if (!res.ok) return []
      const list = (await res.json()) as CdpTarget[]
      return Array.isArray(list) ? list.filter((t) => t.type === 'page') : []
    } catch {
      return []
    }
  }

  async function start() {
    if (!runDir) {
      const targets = await cdpTargets()
      if (targets.length) {
        lastSeen = Date.now()
        return
      }
    }
    await helper('browser-start')
    lastSeen = Date.now()
    for (let i = 0; i < 90; i++) {
      try {
        if ((await fetch(`${NEKO}/`, { signal: AbortSignal.timeout(2000) })).ok) return
      } catch { /* still starting */ }
      await new Promise((ok) => setTimeout(ok, 1000))
    }
    throw new AppError(409, 'browser', 'The browser is taking too long to start. Try again in a minute.')
  }

  async function ensureActiveTarget(): Promise<CdpTarget> {
    let pages = await cdpTargets()
    if (!pages.length && runDir) {
      await start()
      for (let i = 0; i < 20; i++) {
        pages = await cdpTargets()
        if (pages.length) break
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (!pages.length) {
      try {
        const res = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          const created = (await res.json()) as CdpTarget
          if (created?.webSocketDebuggerUrl) return created
        }
      } catch { /* fall through */ }
      throw new AppError(409, 'browser_cdp_unavailable', `Shared browser CDP is not reachable at ${CDP_URL}. Start the shared browser first (or launch Chromium with --remote-debugging-port=9222).`)
    }
    return pages.find((p) => p.url && !p.url.startsWith('devtools://')) ?? pages[0]!
  }

  async function withCdp<T>(fn: (send: (method: string, params?: Record<string, unknown>) => Promise<any>, target: CdpTarget) => Promise<T>): Promise<T> {
    const target = await ensureActiveTarget()
    if (!target.webSocketDebuggerUrl) throw new AppError(409, 'browser_cdp_unavailable', 'Active browser tab does not expose a WebSocket debugger URL.')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to browser CDP WebSocket.')), 8000)
      ws.once('open', () => { clearTimeout(timer); resolve() })
      ws.once('error', (err) => { clearTimeout(timer); reject(err) })
    })
    let seq = 0
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP command failed'))
          else p.resolve(msg.result)
        }
      } catch { /* ignore */ }
    })
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }), (err) => {
          if (err) {
            pending.delete(id)
            reject(err)
          }
        })
      })
    try {
      return await fn(send, target)
    } finally {
      try { ws.close() } catch { /* ignore */ }
    }
  }

  /** Someone connected to the stream right now (members in DevDash and guests on their own page alike)? */
  async function anyoneWatching() {
    const token = apiToken()
    if (!token) return false
    try {
      const r = await fetch(`${NEKO}/api/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
      const sessions = (await r.json()) as { state?: { is_connected?: boolean } }[]
      return Array.isArray(sessions) && sessions.some((s) => s.state?.is_connected)
    } catch {
      return false
    }
  }

  // Every minute: an unwatched browser stops after 30 minutes.
  setInterval(() => {
    void (async () => {
      if (!runDir) return
      if (!lastSeen) {
        const r = await helper<{ running: boolean }>('browser-status').catch(() => ({ running: false }))
        if (r.running) lastSeen = Date.now()
      } else if (Date.now() - lastSeen > IDLE_MS) {
        if (await anyoneWatching()) lastSeen = Date.now()
        else {
          lastSeen = 0
          console.log('browser stopped: nobody watched for 30 minutes')
          await helper('browser-stop').catch((err) => console.error('browser stop:', (err as Error).message))
        }
      }
    })()
  }, 60_000).unref()

  const link = (i: Invite) => `${origin}/watch/${unseal(masterKey, i.token_sealed, `browser-invite:${i.id}`).toString()}`
  const dto = (i: Invite) => ({ id: i.id, label: i.label, canControl: i.can_control === 1, expiresAt: i.expires_at, creator: i.creator_name, createdAt: i.created_at, url: link(i) })

  async function status() {
    const pages = await cdpTargets()
    if (pages.length) {
      const active = pages[0]!
      return {
        running: true,
        cdpConnected: true,
        currentUrl: active.url,
        currentTitle: active.title,
        tabs: pages.map((p) => ({ id: p.id, title: p.title, url: p.url })),
        lastAiAction,
        recentAiActions: recentAiActions.slice(0, 8),
      }
    }
    const helperRunning = runDir ? (await helper<{ running: boolean }>('browser-status').catch(() => ({ running: false }))).running : false
    return {
      running: helperRunning,
      cdpConnected: false,
      currentUrl: null as string | null,
      currentTitle: null as string | null,
      tabs: [] as { id: string; title: string; url: string }[],
      lastAiAction,
      recentAiActions: recentAiActions.slice(0, 8),
    }
  }

  async function navigate(user: Pick<User, 'name'>, url: string) {
    const clean = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
    recordAiAction(user.name, 'navigate', clean)
    return withCdp(async (send) => {
      await send('Page.enable')
      await send('Page.navigate', { url: clean })
      await new Promise((r) => setTimeout(r, 900))
      const evalRes = await send('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
      })
      return (evalRes?.result?.value as { url: string; title: string }) ?? { url: clean, title: '' }
    })
  }

  async function click(user: Pick<User, 'name'>, selector: string) {
    recordAiAction(user.name, 'click', selector)
    return withCdp(async (send) => {
      const expr = `(() => {
        const sel = ${JSON.stringify(selector)};
        let el = null;
        try { el = document.querySelector(sel); } catch {}
        if (!el) {
          const all = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"], label'));
          el = all.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(sel.toLowerCase())) || null;
        }
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const prevOutline = el.style.outline;
        el.style.outline = '2px solid #10b981';
        setTimeout(() => { try { el.style.outline = prevOutline; } catch {} }, 900);
        if (typeof el.click === 'function') el.click();
        return { found: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 120), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
      const val = res?.result?.value as { found: boolean; tag?: string; text?: string; x?: number; y?: number } | undefined
      if (!val?.found) throw new AppError(404, 'element_not_found', `Element not found for selector or text: ${selector}`)
      return val
    })
  }

  async function type(user: Pick<User, 'name'>, selector: string, text: string, submit = false) {
    recordAiAction(user.name, 'type', `${selector} ← "${text.slice(0, 40)}"`)
    return withCdp(async (send) => {
      const expr = `(() => {
        const sel = ${JSON.stringify(selector)};
        const val = ${JSON.stringify(text)};
        const sub = ${JSON.stringify(submit)};
        let el = null;
        try { el = document.querySelector(sel); } catch {}
        if (!el) {
          const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
          el = inputs.find(e => (e.getAttribute('placeholder') || e.getAttribute('name') || e.getAttribute('aria-label') || '').toLowerCase().includes(sel.toLowerCase())) || inputs[0] || null;
        }
        if (!el) return { found: false };
        el.focus();
        if ('value' in el) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
        } else {
          el.textContent = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (sub && el.form) {
          if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
          else el.form.submit();
        }
        return { found: true, tag: el.tagName.toLowerCase() };
      })()`
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
      const val = res?.result?.value as { found: boolean } | undefined
      if (!val?.found) throw new AppError(404, 'element_not_found', `Input element not found for: ${selector}`)
      if (submit) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      return { ok: true, selector, submitted: submit }
    })
  }

  async function press(user: Pick<User, 'name'>, key: string) {
    recordAiAction(user.name, 'press', key)
    return withCdp(async (send) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key })
      return { ok: true, key }
    })
  }

  async function snapshot(user: Pick<User, 'name'>) {
    recordAiAction(user.name, 'snapshot', 'Inspecting page DOM & interactive elements')
    return withCdp(async (send) => {
      const expr = `(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const selectorFor = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
          if (el.getAttribute('aria-label')) return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]';
          if (el.getAttribute('placeholder')) return el.tagName.toLowerCase() + '[placeholder="' + el.getAttribute('placeholder') + '"]';
          return el.tagName.toLowerCase();
        };
        const interactives = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"]'))
          .slice(0, 60)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            selector: selectorFor(el),
            text: clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 100),
            href: el.getAttribute('href') || undefined,
            type: el.getAttribute('type') || undefined,
          }));
        return {
          url: location.href,
          title: document.title,
          text: clean(document.body?.innerText || '').slice(0, 4000),
          elements: interactives,
        };
      })()`
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
      return res?.result?.value ?? { url: '', title: '', text: '', elements: [] }
    })
  }

  async function screenshot(user: Pick<User, 'name'>) {
    recordAiAction(user.name, 'screenshot', 'Capturing live viewport')
    return withCdp(async (send) => {
      await send('Page.enable')
      const res = await send('Page.captureScreenshot', { format: 'png' })
      return { format: 'png', data: String(res?.data ?? '') }
    })
  }

  async function evaluate(user: Pick<User, 'name'>, expression: string) {
    recordAiAction(user.name, 'eval', expression.slice(0, 80))
    return withCdp(async (send) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (res?.exceptionDetails) {
        throw new AppError(400, 'eval_error', res.exceptionDetails.text || 'JavaScript evaluation failed.')
      }
      return { result: res?.result?.value ?? res?.result?.description ?? null }
    })
  }

  function registerMcp() {
    if (!agents) return
    const who = (username: string) => {
      const u = q.user.get(username) as User | undefined
      if (!u) throw new AppError(403, 'forbidden', 'Unknown member.')
      return u
    }
    const args = (params: unknown) => (((params ?? {}) as { args?: Record<string, unknown> }).args ?? {})
    const need = (v: unknown, what: string) =>
      typeof v === 'string' && v.trim() ? v.trim() : (() => { throw new AppError(400, 'bad_args', `Pass ${what}.`) })()

    agents.onRpc('mcp.browser_status', () => status())
    agents.onRpc('mcp.browser_navigate', (u, p) => navigate(who(u), need(args(p).url, 'url')))
    agents.onRpc('mcp.browser_click', (u, p) => click(who(u), need(args(p).selector, 'selector')))
    agents.onRpc('mcp.browser_type', (u, p) => {
      const a = args(p)
      return type(who(u), need(a.selector, 'selector'), typeof a.text === 'string' ? a.text : '', a.submit === true)
    })
    agents.onRpc('mcp.browser_press', (u, p) => press(who(u), need(args(p).key, 'key')))
    agents.onRpc('mcp.browser_snapshot', (u) => snapshot(who(u)))
    agents.onRpc('mcp.browser_screenshot', (u) => screenshot(who(u)))
    agents.onRpc('mcp.browser_eval', (u, p) => evaluate(who(u), need(args(p).expression, 'expression')))
  }

  return {
    status,

    /** Starts it if needed and returns the address that signs this member in (neko reads usr/pwd from the URL, then drops them). */
    async open(user: Pick<User, 'name'>) {
      await start()
      if (!runDir) {
        const s = await status()
        if (s.cdpConnected) return s.currentUrl || 'about:blank'
      }
      return `/browser/?${new URLSearchParams({ usr: user.name, pwd: secret('NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD') })}`
    },
    heartbeat: () => void (lastSeen = Date.now()),
    async stop() {
      lastSeen = 0
      await helper('browser-stop')
    },

    navigate,
    click,
    type,
    press,
    snapshot,
    screenshot,
    evaluate,
    registerMcp,

    invites: () => (q.invites.all() as Invite[]).map(dto),
    createInvite(user: Pick<User, 'id'>, o: { label: string; hours: number; canControl: boolean }) {
      const token = newToken()
      const { id } = q.insert.get(sha256(token), o.label.trim(), o.canControl ? 1 : 0, Math.floor(Date.now() / 1000) + o.hours * 3600, user.id) as { id: number }
      q.sealToken.run(seal(masterKey, Buffer.from(token), `browser-invite:${id}`), id)
      return dto((q.invites.all() as Invite[]).find((i) => i.id === id)!)
    },
    /** Revoked guests can't reach /browser/ any more: Caddy checks the invite on every request. */
    revokeInvite(id: number) {
      q.revoke.run(id)
    },

    /** A live invite behind a token, if any. */
    invite(token: string | undefined) {
      if (!token) return null
      const i = q.byHash.get(sha256(token)) as Invite | undefined
      return i && !i.revoked_at && i.expires_at > Date.now() / 1000 ? i : null
    },
    /** For an invite's guest: starts the browser if needed and returns their sign-in address. */
    async guestUrl(i: Invite) {
      await start()
      return `/browser/?${new URLSearchParams({ usr: `${i.label} (guest)`, pwd: secret('NEKO_MEMBER_MULTIUSER_USER_PASSWORD') })}`
    },
  }
}

export type BrowserService = ReturnType<typeof browserService>
