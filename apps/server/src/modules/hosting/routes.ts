import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { HostingService, Kind } from './service.ts'

const KindZ = z.enum(['application', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'])
const DbKindZ = z.enum(['postgres', 'mysql', 'mariadb', 'mongo', 'redis'])
const KindP = {
  parse: (v: string) => {
    const r = KindZ.safeParse(v)
    if (!r.success) throw new AppError(404, 'not_found', 'Unknown kind.')
    return r.data
  },
}

const Create = z.object({
  name: z.string().min(1).max(41),
  project: z.string().max(60).optional(),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('git'), url: z.string().min(4).max(500), branch: z.string().max(200).optional(), buildPath: z.string().max(300).optional() }),
    z.object({ type: z.literal('docker'), image: z.string().min(1).max(300) }),
    z.object({ type: z.literal('compose'), file: z.string().min(1).max(100_000) }),
  ]),
  buildType: z.enum(['nixpacks', 'dockerfile', 'railpack', 'heroku_buildpacks', 'paketo_buildpacks', 'static']).optional(),
  dockerfile: z.string().max(300).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  env: z.string().max(50_000).optional(),
  domain: z.string().max(253).nullable().optional(),
  deploy: z.boolean().optional(),
})

const Update = z.object({
  name: z.string().min(1).max(60).optional(),
  url: z.string().max(500).optional(),
  branch: z.string().max(200).optional(),
  buildPath: z.string().max(300).optional(),
  buildType: z.enum(['nixpacks', 'dockerfile', 'railpack', 'heroku_buildpacks', 'paketo_buildpacks', 'static']).optional(),
  dockerfile: z.string().max(300).optional(),
  dockerImage: z.string().max(300).optional(),
  composeFile: z.string().max(100_000).optional(),
  env: z.string().max(50_000).optional(),
  command: z.string().max(2000).nullable().optional(),
  memoryLimit: z.string().max(40).nullable().optional(),
  cpuLimit: z.string().max(40).nullable().optional(),
  redeploy: z.boolean().optional(),
})

const AddDomain = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional(),
  https: z.boolean().optional(),
  path: z.string().max(200).optional(),
  serviceName: z.string().max(120).nullable().optional(),
})

const CreateDb = z.object({
  kind: DbKindZ,
  name: z.string().min(1).max(41),
  project: z.string().max(60).optional(),
  databaseName: z.string().max(80).optional(),
  databaseUser: z.string().max(80).optional(),
  databasePassword: z.string().max(120).optional(),
  databaseRootPassword: z.string().max(120).optional(),
  dockerImage: z.string().max(200).optional(),
  externalPort: z.number().int().min(1).max(65535).nullable().optional(),
  deploy: z.boolean().optional(),
})

const DokployCall = z.object({
  procedure: z.string().min(3).max(160),
  input: z.record(z.string(), z.unknown()).optional(),
  method: z.enum(['GET', 'POST']).optional(),
})

const Analyze = z.object({
  kind: KindZ.optional(),
  appId: z.string().max(120).optional(),
  appName: z.string().max(120).optional(),
}).optional()

const Ask = z.object({ prompt: z.string().min(1).max(10_000) })

export type AskClaude = (user: AuthEnv['Variables']['user'], prompt: string) => Promise<{ sessionId: string }>
export type AnalyzeWithClaude = (
  user: AuthEnv['Variables']['user'],
  deploymentId: string,
  meta?: { kind?: Kind; appId?: string; appName?: string },
) => Promise<{ sessionId: string }>

export function hostingRoutes(
  hosting: HostingService,
  askClaude: AskClaude,
  analyzeWithClaude: AnalyzeWithClaude,
  mw: ReturnType<typeof authMiddleware>,
) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/status', async (c) => c.json(await hosting.status()))
    .get('/apps', async (c) => c.json({ apps: await hosting.list() }))
    .get('/apps/:kind/:id', async (c) => c.json(await hosting.get(KindP.parse(c.req.param('kind')), c.req.param('id'))))
    .post('/apps', json(Create), async (c) => c.json(await hosting.create(c.get('user'), c.req.valid('json'))))
    .post('/databases', json(CreateDb), async (c) => c.json(await hosting.createDatabase(c.get('user'), c.req.valid('json'))))
    .post('/dokploy', json(DokployCall), async (c) => {
      const b = c.req.valid('json')
      return c.json({ result: await hosting.dokployCall(b.procedure, b.input, b.method) })
    })
    .patch('/apps/:kind/:id', json(Update), async (c) =>
      c.json(await hosting.update(c.get('user'), KindP.parse(c.req.param('kind')), c.req.param('id'), c.req.valid('json'))))
    .post('/apps/:kind/:id/domains', json(AddDomain), async (c) =>
      c.json(await hosting.addDomain(KindP.parse(c.req.param('kind')), c.req.param('id'), c.req.valid('json'))))
    .delete('/domains/:domainId', async (c) => c.json(await hosting.removeDomain(c.req.param('domainId'))))
    .get('/deployments/:id/logs', async (c) => c.json({ logs: await hosting.logs(c.req.param('id')) }))
    // Real Claude Code log analysis: reads real deployment logs from Dokploy and starts a Claude Code session to diagnose & fix.
    .post('/deployments/:id/analyze', json(Analyze), async (c) =>
      c.json(await analyzeWithClaude(c.get('user'), c.req.param('id'), c.req.valid('json'))))
    .post('/apps/:kind/:id/:action', async (c) => {
      const r = z.enum(['deploy', 'redeploy', 'stop', 'start', 'delete']).safeParse(c.req.param('action'))
      if (!r.success) throw new AppError(404, 'not_found', 'Unknown action.')
      return c.json(await hosting.action(KindP.parse(c.req.param('kind')), c.req.param('id'), r.data, c.get('user')))
    })
    // Real Claude Code hosting session: launches a Claude Code session with full hosting_* MCP tools.
    .post('/ask', json(Ask), async (c) => c.json(await askClaude(c.get('user'), c.req.valid('json').prompt)))
}
