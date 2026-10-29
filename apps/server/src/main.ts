import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { loadConfig } from './core/config.ts'
import { openDb } from './core/db.ts'
import { wsRouter } from './core/ws.ts'
import { startBundledDokployDaemon } from './modules/hosting/dokploy-daemon.ts'
import { registerSockets } from './sockets.ts'

const config = loadConfig()
if (!config.runDir) {
  const sock = process.platform === 'win32'
    ? `\\\\.\\pipe\\devdash-agent-${process.pid}`
    : `/tmp/devdash-agent-${process.pid}.sock`
  process.env.DEVDASH_LOCAL_AGENT_SOCKET = sock
  process.env.DEVDASH_AGENT_SOCKET = sock
  process.env.USER ??= process.env.USERNAME ?? 'local'
  await import('../../agent/src/main.ts')
}
const hostingUrl = new URL(config.hosting?.url || 'http://127.0.0.1:3010')
const dokployDaemon = (hostingUrl.hostname === '127.0.0.1' || hostingUrl.hostname === 'localhost')
  ? await startBundledDokployDaemon({
      port: Number(hostingUrl.port) || 3010,
      dataDir: config.dataDir,
      masterKey: config.masterKey.toString('base64'),
    })
  : null
const db = openDb(join(config.dataDir, 'devdash.db'))
const { app, auth, provisioning, terms, agents, claude, services, hub, previews } = createApp({ db, config })

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) =>
  console.log(`devdash ${config.version} listening on 127.0.0.1:${info.port}`))

registerSockets(wsRouter(server as import('node:http').Server, { auth, origin: config.origin, other: previews.upgrade }), { hub, agents, terms, claude, services })
setInterval(() => auth.cleanup(), 3_600_000).unref()
// Provision every member (each success starts watching their agent), then let agents pick up new code once idle.
void provisioning.reconcileAll().then(() => { if (config.runDir) return agents.upgradeAll(provisioning.usernames()) })

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close()
    dokployDaemon?.close()
    db.close()
    process.exit(0)
  })
}
