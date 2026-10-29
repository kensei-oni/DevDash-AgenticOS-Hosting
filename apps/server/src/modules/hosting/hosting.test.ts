import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDb } from '../../core/db.ts'
import { agentsService } from '../agents/service.ts'
import { monitorService } from '../monitor/service.ts'
import { startBundledDokployDaemon } from './dokploy-daemon.ts'
import { hostingService } from './service.ts'

test('hostingService talks to bundled Dokploy via x-agos-key and exposes create, update, domain, log, and action MCP tools', async () => {
  const calls: { url: string; method: string; agosKey: string | undefined; body: unknown }[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(String(input))
    const path = u.pathname + u.search
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null
    calls.push({ url: path, method: init?.method ?? 'GET', agosKey: headers['x-agos-key'], body })
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/api/project.all') {
      return json([{
        projectId: 'p1',
        name: 'agOS',
        environments: [{
          environmentId: 'e1',
          name: 'production',
          applications: [{ applicationId: 'a1', name: 'blog', appName: 'agos-blog', applicationStatus: 'done', domains: [{ domainId: 'd1', host: 'blog.apps.test', https: true, port: 3000 }] }],
          compose: [],
        }],
      }])
    }
    if (path === '/api/application.create') return json({ applicationId: 'a2', appName: 'agos-api-123' })
    if (path.startsWith('/api/application.one')) {
      return json({
        applicationId: 'a1',
        name: 'blog',
        appName: 'agos-blog',
        applicationStatus: 'done',
        buildType: 'nixpacks',
        customGitUrl: 'https://github.com/example/blog.git',
        customGitBranch: 'main',
        env: 'NODE_ENV=production',
        domains: [{ domainId: 'd1', host: 'blog.apps.test', https: true, port: 3000 }],
      })
    }
    if (path.startsWith('/api/deployment.all')) {
      return json([{ deploymentId: 'dep1', title: 'Initial deploy', status: 'done', createdAt: '2026-10-29T00:00:00Z' }])
    }
    if (path.startsWith('/api/deployment.readLogs')) return json({ logs: 'Build succeeded' })
    if (path === '/api/domain.create') return json({ domainId: 'd-new' })
    return json({ ok: true })
  }) as typeof fetch

  const db = openDb(':memory:')
  db.prepare("insert into users (email, username, name, role, password_hash, totp_secret, created_at) values ('a@b.c', 'alice', 'Alice', 'admin', 'x', 'y', 1)").run()
  const rpcs = new Map<string, (u: string, p: unknown) => unknown>()
  const agents = { ...agentsService({ runDir: '' }), onRpc: (m: string, fn: (u: string, p: unknown) => unknown) => void rpcs.set(m, fn) }
  const hosting = hostingService({
    config: {
      url: 'http://127.0.0.1:3010',
      apiKey: null,
      masterKey: 'agos-master-key-test',
      domain: 'apps.test',
      dashboardUrl: 'https://space.test:3443',
    },
    agents,
    db,
  })
  hosting.registerMcp()

  try {
    const st = await hosting.status()
    assert.equal(st.configured, true)
    assert.equal(st.reachable, true)

    const apps = await hosting.list()
    assert.equal(apps.length, 1)
    assert.equal(apps[0]!.name, 'blog')

    const created = await rpcs.get('mcp.hosting_create')!('alice', {
      args: { name: 'my-api', git_url: 'https://github.com/example/api.git', port: 4000 },
    }) as { id: string; url: string }
    assert.equal(created.id, 'a2')
    assert.equal(created.url, 'https://my-api.apps.test')
    assert.ok(calls.some((c) => c.url === '/api/domain.create' && (c.body as { host: string; port: number }).host === 'my-api.apps.test' && (c.body as { port: number }).port === 4000))
    assert.ok(calls.some((c) => c.url === '/api/application.deploy'))
    assert.ok(calls.every((c) => c.agosKey === 'agos-master-key-test'))

    await rpcs.get('mcp.hosting_update')!('alice', {
      args: { kind: 'application', id: 'a1', branch: 'canary', env: 'PORT=4000', redeploy: true },
    })
    assert.ok(calls.some((c) => c.url === '/api/application.saveGitProvider' && (c.body as { customGitBranch: string }).customGitBranch === 'canary'))
    assert.ok(calls.some((c) => c.url === '/api/application.saveEnvironment' && (c.body as { env: string }).env === 'PORT=4000'))
    assert.ok(calls.some((c) => c.url === '/api/application.redeploy'))

    const dom = await rpcs.get('mcp.hosting_domain_add')!('alice', {
      args: { kind: 'application', id: 'a1', host: 'custom.apps.test', port: 3000, https: true },
    }) as { id: string; url: string }
    assert.equal(dom.id, 'd-new')
    assert.equal(dom.url, 'https://custom.apps.test')

    await rpcs.get('mcp.hosting_domain_remove')!('alice', { args: { domain_id: 'd-new' } })
    assert.ok(calls.some((c) => c.url === '/api/domain.delete' && (c.body as { domainId: string }).domainId === 'd-new'))

    const detail = await rpcs.get('mcp.hosting_get')!('alice', { args: { kind: 'application', id: 'a1' } }) as { domains: { url: string }[] }
    assert.equal(detail.domains[0]!.url, 'https://blog.apps.test')
    const log = await rpcs.get('mcp.hosting_logs')!('alice', { args: { deployment_id: 'dep1' } })
    assert.equal(log, 'Build succeeded')
  } finally {
    globalThis.fetch = origFetch
    db.close()
  }
})

test('startBundledDokployDaemon runs on local port, serves Studio & API, and monitorService tracks hosted apps', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agos-dokploy-test-'))
  const port = 33110
  const daemon = await startBundledDokployDaemon({ port, dataDir: tmp, masterKey: 'test-key-123' })
  assert.ok(daemon, 'Bundled Dokploy daemon should start')

  const db = openDb(':memory:')
  const user = { id: 1, username: 'alice', name: 'Alice', email: 'a@b.c', role: 'admin' as const }
  const agents = agentsService({ runDir: '' })
  const hosting = hostingService({
    config: {
      url: `http://127.0.0.1:${port}`,
      apiKey: null,
      masterKey: 'test-key-123',
      domain: null,
      dashboardUrl: `http://127.0.0.1:${port}`,
    },
    agents,
    db,
  })
  const monitor = monitorService({ hosting, agents })

  try {
    const st = await hosting.status()
    assert.equal(st.reachable, true)

    const studioHtml = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())
    assert.ok(studioHtml.includes('Dokploy Studio'))

    const created = await hosting.create(user, {
      name: 'demo-web',
      source: { type: 'docker', image: 'nginx:alpine' },
      port: 8080,
      deploy: true,
    })
    assert.ok(created.id)

    const dbCreated = await hosting.createDatabase(user, {
      kind: 'postgres',
      name: 'demo-pg',
      deploy: true,
    })
    assert.ok(dbCreated.id)

    const fileApp = await hosting.create(user, {
      name: 'uploaded-site',
      source: {
        type: 'files',
        files: [
          { path: 'index.html', content: '<!doctype html><html><body>Hello from uploaded app</body></html>' },
          { path: 'server.js', content: 'console.log("ready")' },
        ],
      },
      startFile: 'index.html',
      runtime: 'static',
      port: 33115,
      deploy: true,
    })
    assert.ok(fileApp.id)

    const listedFiles = await hosting.listFiles(fileApp.id)
    assert.equal(listedFiles.startFile, 'index.html')
    assert.equal(listedFiles.files.length, 2)

    const readIndex = await hosting.readFile(fileApp.id, 'index.html')
    assert.ok(readIndex.content.includes('Hello from uploaded app'))

    const snap = await monitor.snapshot()
    assert.equal(snap.summary.total, 3)
    assert.equal(snap.summary.appsCount, 2)
    assert.equal(snap.summary.databasesCount, 1)
    assert.equal(snap.items.length, 3)
    assert.ok(snap.items.some((i) => i.name === 'demo-web'))
    assert.ok(snap.items.some((i) => i.name === 'uploaded-site'))
    assert.ok(snap.items.some((i) => i.name === 'demo-pg' && i.kind === 'postgres'))
  } finally {
    daemon.close()
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
