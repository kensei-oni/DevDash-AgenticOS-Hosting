import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { MonitorService } from './service.ts'

export type AskMonitorClaude = (user: AuthEnv['Variables']['user'], prompt: string) => Promise<{ sessionId: string }>

export function monitorRoutes(
  monitor: MonitorService,
  askClaude: AskMonitorClaude,
  mw: ReturnType<typeof authMiddleware>,
) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await monitor.snapshot()))
    .post('/ask', json(z.object({ prompt: z.string().min(1).max(10_000) })), async (c) =>
      c.json(await askClaude(c.get('user'), c.req.valid('json').prompt)))
}
