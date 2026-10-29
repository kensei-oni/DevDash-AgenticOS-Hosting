import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from 'node:os'
import { promisify } from 'node:util'
import type { AgentsService } from '../agents/service.ts'
import type { HostingService } from '../hosting/service.ts'

const run = promisify(execFile)

export type MonitorSample = {
  at: number
  cpuPercent: number
  memPercent: number
  rxBytesPerSec: number
  txBytesPerSec: number
}

export type ContainerStat = {
  id: string
  name: string
  cpuPercent: string
  memUsage: string
  memPercent: string
  netIO: string
  blockIO: string
  pids: string
}

function readCpuTicks() {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { idle, total }
}

function readMemory() {
  const total = totalmem()
  let available = freemem()
  let swapTotal = 0
  let swapFree = 0
  if (existsSync('/proc/meminfo')) {
    try {
      const raw = readFileSync('/proc/meminfo', 'utf8')
      const kb = (k: string) => {
        const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))
        return m ? Number(m[1]) * 1024 : null
      }
      available = kb('MemAvailable') ?? available
      swapTotal = kb('SwapTotal') ?? 0
      swapFree = kb('SwapFree') ?? 0
    } catch { /* fallback to os.freemem */ }
  }
  const used = Math.max(0, total - available)
  const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0
  const swapUsed = Math.max(0, swapTotal - swapFree)
  const swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0
  return { total, used, available, percent, swapTotal, swapUsed, swapPercent }
}

function readDisk() {
  try {
    const s = statfsSync(process.cwd())
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    const used = Math.max(0, total - free)
    const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0
    return { total, used, free, percent }
  } catch {
    return { total: 0, used: 0, free: 0, percent: 0 }
  }
}

async function readNetBytes(): Promise<{ rx: number; tx: number }> {
  if (existsSync('/proc/net/dev')) {
    try {
      const lines = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)
      let rx = 0
      let tx = 0
      for (const l of lines) {
        const parts = l.trim().split(/[:\s]+/)
        if (parts.length < 10 || parts[0] === 'lo') continue
        rx += Number(parts[1]) || 0
        tx += Number(parts[9]) || 0
      }
      return { rx, tx }
    } catch { /* fallback */ }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await run('netstat', ['-e'], { timeout: 2000 })
      const m = stdout.match(/Bytes\s+(\d+)\s+(\d+)/i)
      if (m) return { rx: Number(m[1]) || 0, tx: Number(m[2]) || 0 }
    } catch { /* ignore */ }
  }
  return { rx: 0, tx: 0 }
}

async function readDockerStats(): Promise<ContainerStat[]> {
  try {
    const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 5000 })
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const j = JSON.parse(line) as Record<string, string>
        return {
          id: j.ID ?? j.Container ?? '',
          name: j.Name ?? '',
          cpuPercent: j.CPUPerc ?? '0.00%',
          memUsage: j.MemUsage ?? '0B / 0B',
          memPercent: j.MemPerc ?? '0.00%',
          netIO: j.NetIO ?? '0B / 0B',
          blockIO: j.BlockIO ?? '0B / 0B',
          pids: j.PIDs ?? '0',
        }
      })
  } catch {
    return []
  }
}

export function monitorService({ hosting, agents }: { hosting: HostingService; agents: AgentsService }) {
  let prevCpu = readCpuTicks()
  let lastCpuPercent = 0
  let prevNet = { rx: 0, tx: 0, at: Date.now() }
  let lastNetRate = { rxBytesPerSec: 0, txBytesPerSec: 0, totalRx: 0, totalTx: 0 }
  const history: MonitorSample[] = []

  async function sampleNow() {
    const nowCpu = readCpuTicks()
    const dTotal = nowCpu.total - prevCpu.total
    const dIdle = nowCpu.idle - prevCpu.idle
    if (dTotal > 0) {
      lastCpuPercent = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10))
    }
    prevCpu = nowCpu

    const mem = readMemory()
    const nowNet = await readNetBytes()
    const now = Date.now()
    const dtSec = Math.max(0.5, (now - prevNet.at) / 1000)
    if (prevNet.rx > 0 && nowNet.rx >= prevNet.rx) {
      lastNetRate = {
        rxBytesPerSec: Math.round((nowNet.rx - prevNet.rx) / dtSec),
        txBytesPerSec: Math.round((nowNet.tx - prevNet.tx) / dtSec),
        totalRx: nowNet.rx,
        totalTx: nowNet.tx,
      }
    } else {
      lastNetRate = { ...lastNetRate, totalRx: nowNet.rx, totalTx: nowNet.tx }
    }
    prevNet = { rx: nowNet.rx, tx: nowNet.tx, at: now }

    history.push({
      at: now,
      cpuPercent: lastCpuPercent,
      memPercent: mem.percent,
      rxBytesPerSec: lastNetRate.rxBytesPerSec,
      txBytesPerSec: lastNetRate.txBytesPerSec,
    })
    if (history.length > 60) history.shift()
  }

  void readNetBytes().then((n) => { prevNet = { rx: n.rx, tx: n.tx, at: Date.now() } })
  setInterval(() => void sampleNow(), 5000).unref()

  async function snapshot() {
    await sampleNow()
    const cpuList = cpus()
    const mem = readMemory()
    const disk = readDisk()
    const [containers, hostingStatus, hostedApps] = await Promise.all([
      readDockerStats(),
      hosting.status(),
      hosting.list().catch(() => []),
    ])
    const [l1 = 0, l5 = 0, l15 = 0] = loadavg()
    return {
      host: {
        hostname: hostname(),
        platform: `${platform()} ${arch()} (${release()})`,
        uptimeSec: Math.floor(uptime()),
        cpuModel: cpuList[0]?.model ?? 'CPU',
        cpuCores: cpuList.length,
        cpuPercent: lastCpuPercent,
        loadAvg: [Math.round(l1 * 100) / 100, Math.round(l5 * 100) / 100, Math.round(l15 * 100) / 100] as [number, number, number],
      },
      memory: mem,
      disk,
      network: lastNetRate,
      history,
      containers,
      hosting: {
        ...hostingStatus,
        apps: hostedApps,
      },
    }
  }

  function registerMcp() {
    agents.onRpc('mcp.hosting_monitor', () => snapshot())
  }

  return { snapshot, registerMcp }
}

export type MonitorService = ReturnType<typeof monitorService>
