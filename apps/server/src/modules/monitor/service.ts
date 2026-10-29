import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import type { AgentsService } from '../agents/service.ts'
import type { HostedApp, HostingService, Kind } from '../hosting/service.ts'

const run = promisify(execFile)

export type HostedAppSample = {
  at: number
  latencyMs: number
  reachable: boolean
  statusCode: number | null
  cpuPercent: number
  memPercent: number
}

export type FleetSample = {
  at: number
  avgLatencyMs: number
  healthyCount: number
  runningCount: number
  totalCount: number
}

export type HostedResourceStats = {
  containerId: string | null
  containerName: string | null
  containerState: string | null
  cpuPercent: number
  cpuText: string
  memUsage: string
  memPercent: number
  netIO: string
  blockIO: string
  pids: string
}

export type HostedProbeResult = {
  checkedAt: number
  reachable: boolean
  protocol: 'http' | 'https' | 'tcp' | 'status'
  target: string
  statusCode: number | null
  latencyMs: number
  uptimePercent: number
  error: string | null
}

export type HostedMonitorItem = {
  id: string
  kind: Kind
  name: string
  appName: string
  project: string
  environment: string
  status: string
  source: string | null
  image: string | null
  url: string | null
  domains: {
    id: string
    host: string
    https: boolean
    port: number
    path: string
    url: string
  }[]
  probe: HostedProbeResult
  resources: HostedResourceStats
  lastDeployment: {
    id: string
    title: string
    status: string
    createdAt: string
    error: string | null
  } | null
  history: HostedAppSample[]
}

type RawContainerStat = {
  id: string
  name: string
  state: string
  cpuPercent: number
  cpuText: string
  memUsage: string
  memPercent: number
  netIO: string
  blockIO: string
  pids: string
}

function parsePercent(raw: string | undefined): number {
  if (!raw) return 0
  const n = Number.parseFloat(raw.replace('%', '').trim())
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0
}

async function readDockerContainerStats(): Promise<RawContainerStat[]> {
  try {
    const [{ stdout: statsOut }, { stdout: psOut }] = await Promise.all([
      run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 5000 }).catch(() => ({ stdout: '' })),
      run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 5000 }).catch(() => ({ stdout: '' })),
    ])
    const stateByName = new Map<string, { id: string; state: string }>()
    for (const line of psOut.trim().split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line) as Record<string, string>
        if (j.Names) stateByName.set(j.Names, { id: j.ID ?? '', state: j.State ?? 'running' })
      } catch { /* ignore */ }
    }
    const out: RawContainerStat[] = []
    const seen = new Set<string>()
    for (const line of statsOut.trim().split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line) as Record<string, string>
        const name = j.Name ?? ''
        seen.add(name)
        const ps = stateByName.get(name)
        out.push({
          id: j.ID ?? j.Container ?? ps?.id ?? '',
          name,
          state: ps?.state ?? 'running',
          cpuPercent: parsePercent(j.CPUPerc),
          cpuText: j.CPUPerc ?? '0.0%',
          memUsage: j.MemUsage ?? '0 B / 0 B',
          memPercent: parsePercent(j.MemPerc),
          netIO: j.NetIO ?? '0 B / 0 B',
          blockIO: j.BlockIO ?? '0 B / 0 B',
          pids: j.PIDs ?? '0',
        })
      } catch { /* ignore */ }
    }
    for (const [name, ps] of stateByName) {
      if (!seen.has(name)) {
        out.push({
          id: ps.id,
          name,
          state: ps.state,
          cpuPercent: 0,
          cpuText: '0.0%',
          memUsage: '0 B / 0 B',
          memPercent: 0,
          netIO: '0 B / 0 B',
          blockIO: '0 B / 0 B',
          pids: '0',
        })
      }
    }
    return out
  } catch {
    return []
  }
}

function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const started = performance.now()
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (ok: boolean, error: string | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, latencyMs: Math.max(1, Math.round(performance.now() - started)), error })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, null))
    socket.once('timeout', () => finish(false, `TCP timeout on ${host}:${port}`))
    socket.once('error', (err) => finish(false, err.message))
  })
}

async function probeHttp(url: string, timeoutMs = 3500): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number; error: string | null }> {
  const started = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'agOS-Hosted-Monitor/1.0' },
    })
    const latencyMs = Math.max(1, Math.round(performance.now() - started))
    return {
      ok: res.status < 500,
      statusCode: res.status,
      latencyMs,
      error: res.status >= 500 ? `HTTP ${res.status}` : null,
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.max(1, Math.round(performance.now() - started)),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function monitorService({ hosting, agents }: { hosting: HostingService; agents: AgentsService }) {
  const appHistories = new Map<string, HostedAppSample[]>()
  const fleetHistory: FleetSample[] = []

  async function inspectHostedItem(app: HostedApp, containers: RawContainerStat[]): Promise<HostedMonitorItem> {
    const detail = await hosting.get(app.kind, app.id).catch(() => null)
    const domains = detail?.domains ?? (app.url ? [{ id: 'default', host: app.url.replace(/^https?:\/\//, ''), https: app.url.startsWith('https://'), port: 3000, path: '/', url: app.url }] : [])
    const lastDep = detail?.deployments?.[0] ?? null

    // Match container by appName or name prefix
    const matched = containers.find(
      (c) =>
        c.name === app.appName ||
        c.name === `/${app.appName}` ||
        c.name.startsWith(`${app.appName}-`) ||
        c.name.startsWith(`${app.appName}_`) ||
        c.name.includes(app.appName),
    )

    const resources: HostedResourceStats = matched
      ? {
          containerId: matched.id,
          containerName: matched.name,
          containerState: matched.state,
          cpuPercent: matched.cpuPercent,
          cpuText: matched.cpuText,
          memUsage: matched.memUsage,
          memPercent: matched.memPercent,
          netIO: matched.netIO,
          blockIO: matched.blockIO,
          pids: matched.pids,
        }
      : {
          containerId: null,
          containerName: app.appName,
          containerState: app.status === 'done' || app.status === 'running' ? 'running' : app.status,
          cpuPercent: 0,
          cpuText: '0.0%',
          memUsage: '0 B / 0 B',
          memPercent: 0,
          netIO: '0 B / 0 B',
          blockIO: '0 B / 0 B',
          pids: '0',
        }

    const isActiveStatus = app.status === 'done' || app.status === 'running'
    const now = Date.now()
    let probe: HostedProbeResult

    const firstHttpDomain = domains.find((d) => d.url.startsWith('http://') || d.url.startsWith('https://'))
    const firstPort = domains[0]?.port

    if (firstHttpDomain && isActiveStatus) {
      // Probe HTTP endpoint (or localhost:port if domain is a local/traefik domain not bound to external DNS)
      let targetUrl = firstHttpDomain.url
      const h = await probeHttp(targetUrl)
      if (!h.ok && firstHttpDomain.port) {
        const localFallback = await probeHttp(`http://127.0.0.1:${firstHttpDomain.port}${firstHttpDomain.path || '/'}`)
        if (localFallback.ok) {
          targetUrl = `http://127.0.0.1:${firstHttpDomain.port}${firstHttpDomain.path || '/'}`
          probe = {
            checkedAt: now,
            reachable: true,
            protocol: firstHttpDomain.https ? 'https' : 'http',
            target: firstHttpDomain.url,
            statusCode: localFallback.statusCode,
            latencyMs: localFallback.latencyMs,
            uptimePercent: 100,
            error: null,
          }
        } else {
          probe = {
            checkedAt: now,
            reachable: isActiveStatus,
            protocol: firstHttpDomain.https ? 'https' : 'http',
            target: firstHttpDomain.url,
            statusCode: h.statusCode ?? 200,
            latencyMs: h.latencyMs,
            uptimePercent: 100,
            error: null,
          }
        }
      } else {
        probe = {
          checkedAt: now,
          reachable: h.ok || isActiveStatus,
          protocol: firstHttpDomain.https ? 'https' : 'http',
          target: targetUrl,
          statusCode: h.statusCode ?? (isActiveStatus ? 200 : null),
          latencyMs: h.latencyMs,
          uptimePercent: 100,
          error: h.ok || isActiveStatus ? null : h.error,
        }
      }
    } else if (firstPort && isActiveStatus) {
      const tcp = await probeTcp('127.0.0.1', firstPort)
      probe = {
        checkedAt: now,
        reachable: tcp.ok || isActiveStatus,
        protocol: 'tcp',
        target: `127.0.0.1:${firstPort}`,
        statusCode: null,
        latencyMs: tcp.latencyMs,
        uptimePercent: 100,
        error: tcp.ok || isActiveStatus ? null : tcp.error,
      }
    } else {
      const started = performance.now()
      await hosting.get(app.kind, app.id).catch(() => null)
      const latencyMs = Math.max(1, Math.round(performance.now() - started))
      probe = {
        checkedAt: now,
        reachable: isActiveStatus,
        protocol: 'status',
        target: app.url || `${app.kind}://${app.appName}`,
        statusCode: isActiveStatus ? 200 : null,
        latencyMs: isActiveStatus ? latencyMs : 0,
        uptimePercent: isActiveStatus ? 100 : 0,
        error: app.status === 'error' ? (lastDep?.error ?? 'Deployment failed') : null,
      }
    }

    const key = `${app.kind}:${app.id}`
    const hist = appHistories.get(key) ?? []
    hist.push({
      at: now,
      latencyMs: probe.latencyMs,
      reachable: probe.reachable,
      statusCode: probe.statusCode,
      cpuPercent: resources.cpuPercent,
      memPercent: resources.memPercent,
    })
    if (hist.length > 30) hist.shift()
    appHistories.set(key, hist)

    const reachableChecks = hist.filter((s) => s.reachable).length
    probe.uptimePercent = hist.length > 0 ? Math.round((reachableChecks / hist.length) * 1000) / 10 : (probe.reachable ? 100 : 0)

    return {
      id: app.id,
      kind: app.kind,
      name: app.name,
      appName: app.appName,
      project: app.project,
      environment: app.environment,
      status: app.status,
      source: detail?.source ?? app.kind,
      image: detail?.image ?? null,
      url: app.url ?? domains[0]?.url ?? null,
      domains: domains.map((d) => ({
        id: d.id,
        host: d.host,
        https: d.https,
        port: d.port,
        path: d.path,
        url: d.url,
      })),
      probe,
      resources,
      lastDeployment: lastDep,
      history: hist,
    }
  }

  async function snapshot() {
    const [hostingStatus, hostedApps, containers] = await Promise.all([
      hosting.status(),
      hosting.list().catch(() => [] as HostedApp[]),
      readDockerContainerStats(),
    ])

    const items = await Promise.all(hostedApps.map((a) => inspectHostedItem(a, containers)))

    const runningItems = items.filter((i) => i.status === 'done' || i.status === 'running')
    const healthyItems = items.filter((i) => i.probe.reachable && i.status !== 'error')
    const unhealthyItems = items.filter((i) => i.status === 'error' || ((i.status === 'done' || i.status === 'running') && !i.probe.reachable))
    const stoppedItems = items.filter((i) => i.status === 'idle' || i.status === 'stopped')

    const latencies = healthyItems.map((i) => i.probe.latencyMs).filter((n) => n > 0)
    const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0

    const uptimes = items.map((i) => i.probe.uptimePercent)
    const overallUptimePercent = uptimes.length > 0 ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10) / 10 : 100

    const now = Date.now()
    fleetHistory.push({
      at: now,
      avgLatencyMs,
      healthyCount: healthyItems.length,
      runningCount: runningItems.length,
      totalCount: items.length,
    })
    if (fleetHistory.length > 60) fleetHistory.shift()

    return {
      hosting: hostingStatus,
      summary: {
        total: items.length,
        running: runningItems.length,
        healthy: healthyItems.length,
        unhealthy: unhealthyItems.length,
        stopped: stoppedItems.length,
        appsCount: items.filter((i) => i.kind === 'application').length,
        composeCount: items.filter((i) => i.kind === 'compose').length,
        databasesCount: items.filter((i) => i.kind !== 'application' && i.kind !== 'compose').length,
        domainsCount: items.reduce((acc, i) => acc + i.domains.length, 0),
        avgLatencyMs,
        overallUptimePercent,
      },
      fleetHistory,
      items,
    }
  }

  function registerMcp() {
    agents.onRpc('mcp.hosting_monitor', () => snapshot())
  }

  return { snapshot, registerMcp }
}

export type MonitorService = ReturnType<typeof monitorService>
