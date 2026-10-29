import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { json, rateLimit } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { BrowserService } from './service.ts'

const WATCH_COOKIE = 'dd_watch'

export type AskBrowserClaude = (user: AuthEnv['Variables']['user'], prompt: string) => Promise<{ sessionId: string }>

export function browserRoutes(
  browser: BrowserService,
  mw: ReturnType<typeof authMiddleware>,
  askClaude?: AskBrowserClaude,
) {
  return new Hono<AuthEnv>()
    // Caddy asks this before every /browser/ request (forward_auth): a signed-in member, or a guest with a live invite.
    .get('/check', (c) => {
      if (mw.signedIn(c) || browser.invite(getCookie(c, WATCH_COOKIE))) return c.body(null, 204)
      return c.body(null, 401)
    })
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await browser.status()))
    .post('/open', async (c) => c.json({ url: await browser.open(c.get('user')) }))
    .post('/heartbeat', (c) => {
      browser.heartbeat()
      return c.json({ ok: true })
    })
    .post('/stop', async (c) => {
      console.log(`browser stopped by ${c.get('user').username}`)
      await browser.stop()
      return c.json({ ok: true })
    })
    // Real-time CDP controls (also exposed to Claude Code via browser_* MCP tools)
    .post('/navigate', json(z.object({ url: z.string().min(1).max(2000) })), async (c) =>
      c.json(await browser.navigate(c.get('user'), c.req.valid('json').url)))
    .post('/click', json(z.object({ selector: z.string().min(1).max(500) })), async (c) =>
      c.json(await browser.click(c.get('user'), c.req.valid('json').selector)))
    .post('/type', json(z.object({ selector: z.string().min(1).max(500), text: z.string().max(10_000), submit: z.boolean().optional() })), async (c) => {
      const b = c.req.valid('json')
      return c.json(await browser.type(c.get('user'), b.selector, b.text, b.submit))
    })
    .post('/press', json(z.object({ key: z.string().min(1).max(60) })), async (c) =>
      c.json(await browser.press(c.get('user'), c.req.valid('json').key)))
    .get('/snapshot', async (c) => c.json(await browser.snapshot(c.get('user'))))
    .get('/screenshot', async (c) => c.json(await browser.screenshot(c.get('user'))))
    .post('/eval', json(z.object({ expression: z.string().min(1).max(20_000) })), async (c) =>
      c.json(await browser.evaluate(c.get('user'), c.req.valid('json').expression)))
    .post('/ask', json(z.object({ prompt: z.string().min(1).max(10_000) })), async (c) => {
      if (!askClaude) throw new Error('Claude integration is not wired.')
      return c.json(await askClaude(c.get('user'), c.req.valid('json').prompt))
    })
    .get('/invites', (c) => c.json({ invites: browser.invites() }))
    .post('/invites', json(z.object({ label: z.string().trim().min(1).max(60), hours: z.number().int().min(1).max(24 * 30), canControl: z.boolean().default(false) })),
      (c) => c.json({ invite: browser.createInvite(c.get('user'), c.req.valid('json')) }))
    .delete('/invites/:id', (c) => {
      browser.revokeInvite(Number(c.req.param('id')))
      return c.json({ ok: true })
    })
}

/** /watch/<token>: a guest's way in. Sets the invite cookie for /browser/ and sends them to it, signed in. */
export function watchRoutes(browser: BrowserService, ip: (c: import('hono').Context) => string) {
  return new Hono().get('/:token', async (c) => {
    rateLimit(`watch:${ip(c)}`, 30, 10 * 60_000)
    const invite = browser.invite(c.req.param('token'))
    if (!invite) {
      c.header('x-robots-tag', 'noindex')
      return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:24rem;padding:1rem"><h1 style="font-size:1.2rem">This invite doesn't work</h1>
<p style="opacity:.7">It may have expired or been turned off. Ask the person who sent it for a new one.</p></main></body>`, 404)
    }
    setCookie(c, WATCH_COOKIE, c.req.param('token'), {
      path: '/browser/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: Math.max(60, invite.expires_at - Math.floor(Date.now() / 1000)),
    })
    return c.redirect(await browser.guestUrl(invite))
  })
}
