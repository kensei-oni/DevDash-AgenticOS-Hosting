import { useState } from 'react'
import { useMutation, useQuery, queryOptions } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Activity, Cpu, ExternalLink, HardDrive, MemoryStick, Network, RefreshCw, Rocket, Server, Sparkles } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { lightOf } from '../hosting/HostingPage'

export const monitorQuery = queryOptions({
  queryKey: ['monitor'],
  queryFn: () => unwrap(api.api.monitor.$get()),
  refetchInterval: 3_000,
})

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function Sparkline({ values, max = 100 }: { values: number[]; max?: number }) {
  if (!values.length) return <div className="h-14 w-full rounded bg-muted/30" />
  const pts = values.length === 1 ? [values[0]!, values[0]!] : values
  const top = Math.max(max, ...pts, 1)
  const w = 240
  const h = 56
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * w
    const y = h - Math.min(1, Math.max(0, v / top)) * (h - 8) - 4
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = `M ${coords.join(' L ')}`
  const area = `${line} L ${w},${h} L 0,${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full overflow-visible" preserveAspectRatio="none">
      <path d={area} className="fill-foreground/10" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.75" className="text-foreground" />
    </svg>
  )
}

export function MonitorPage() {
  const navigate = useNavigate()
  const q = useQuery(monitorQuery)
  const [asking, setAsking] = useState(false)
  const d = q.data

  const cpuSeries = (d?.history ?? []).map((s) => s.cpuPercent)
  const memSeries = (d?.history ?? []).map((s) => s.memPercent)
  const netSeries = (d?.history ?? []).map((s) => (s.rxBytesPerSec + s.txBytesPerSec) / 1024)
  const maxNetKb = Math.max(64, ...netSeries)

  return (
    <>
      <PageHeader
        title="Monitor"
        description="Real-time telemetry for this server, bundled Dokploy apps, and Docker containers"
        actions={<div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching} aria-label="Refresh">
            <RefreshCw className={q.isFetching ? 'animate-spin' : ''} />
          </Button>
          <Button asChild size="sm" variant="outline"><Link to="/hosting"><Rocket />Hosting</Link></Button>
          <Button size="sm" onClick={() => setAsking(true)}><Sparkles />Ask Claude</Button>
        </div>}
      />
      <PageBody>
        <ErrorAlert error={q.error} />
        {q.isPending && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}
          </div>
        )}
        {d && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <StatusLight state="live" />
                  {d.host.hostname}
                </span>
                <span className="text-muted-foreground">{d.host.platform}</span>
                <span className="text-muted-foreground">{d.host.cpuModel} ({d.host.cpuCores} cores)</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                <span>Load: <strong className="font-mono text-foreground">{d.host.loadAvg.join(' / ')}</strong></span>
                <span>Uptime: <strong className="font-mono text-foreground">{fmtUptime(d.host.uptimeSec)}</strong></span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Cpu className="size-3.5" />CPU Load</span>
                  <span className="font-mono text-lg font-semibold">{d.host.cpuPercent.toFixed(1)}%</span>
                </div>
                <Sparkline values={cpuSeries} max={100} />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{d.host.cpuCores} cores</span>
                  <span>1m load {d.host.loadAvg[0]}</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><MemoryStick className="size-3.5" />Memory</span>
                  <span className="font-mono text-lg font-semibold">{d.memory.percent.toFixed(1)}%</span>
                </div>
                <Sparkline values={memSeries} max={100} />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{fmtBytes(d.memory.used)} / {fmtBytes(d.memory.total)}</span>
                  <span>{d.memory.swapTotal > 0 ? `Swap ${d.memory.swapPercent}%` : `${fmtBytes(d.memory.available)} free`}</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><HardDrive className="size-3.5" />Disk</span>
                  <span className="font-mono text-lg font-semibold">{d.disk.percent.toFixed(1)}%</span>
                </div>
                <div className="my-auto flex flex-col gap-2 py-2">
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-foreground transition-all" style={{ width: `${Math.min(100, d.disk.percent)}%` }} />
                  </div>
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{fmtBytes(d.disk.used)} used</span>
                  <span>{fmtBytes(d.disk.free)} free</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Network className="size-3.5" />Network I/O</span>
                  <span className="font-mono text-sm font-semibold">↓ {fmtBytes(d.network.rxBytesPerSec)}/s</span>
                </div>
                <Sparkline values={netSeries} max={maxNetKb} />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>↑ {fmtBytes(d.network.txBytesPerSec)}/s</span>
                  <span>Total ↓{fmtBytes(d.network.totalRx)} ↑{fmtBytes(d.network.totalTx)}</span>
                </div>
              </div>
            </div>

            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Rocket className="size-4" />Bundled Dokploy Hosting Engine ({d.hosting.url})
                </h2>
                <div className="flex items-center gap-2">
                  <StatusLight state={d.hosting.reachable ? 'live' : 'error'} />
                  <span className="text-xs text-muted-foreground">
                    {d.hosting.reachable ? 'Engine Online · Traefik :8880/:8843' : 'Engine Unreachable'}
                  </span>
                  {d.hosting.dashboardUrl && (
                    <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
                      <a href={d.hosting.dashboardUrl} target="_blank" rel="noreferrer">Dashboard<ExternalLink className="size-3" /></a>
                    </Button>
                  )}
                </div>
              </div>
              {!d.hosting.apps.length ? (
                <p className="rounded-lg border px-3.5 py-3 text-xs text-muted-foreground">
                  {d.hosting.reachable
                    ? 'No hosted applications or compose stacks deployed yet.'
                    : `Bundled Dokploy engine at ${d.hosting.url} is not reachable yet (${d.hosting.error ?? 'offline'}).`}
                </p>
              ) : (
                <ItemGroup className="gap-1.5">
                  {d.hosting.apps.map((a) => (
                    <Item key={a.id} variant="outline" size="sm" asChild>
                      <Link to="/hosting/$kind/$id" params={{ kind: a.kind, id: a.id }}>
                        <ItemMedia><StatusLight state={lightOf(a.status)} /></ItemMedia>
                        <ItemContent>
                          <ItemTitle>{a.name}</ItemTitle>
                          <ItemDescription>{a.project} · {a.environment} · {a.kind}{a.url ? ` · ${a.url}` : ''}</ItemDescription>
                        </ItemContent>
                        <ItemActions><Badge variant="secondary" className="font-mono text-[11px] capitalize">{a.status}</Badge></ItemActions>
                      </Link>
                    </Item>
                  ))}
                </ItemGroup>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Server className="size-4" />Live Docker &amp; Hosted Containers ({d.containers.length})
                </h2>
              </div>
              {!d.containers.length ? (
                <p className="rounded-lg border px-3.5 py-3 text-xs text-muted-foreground">
                  No running Docker containers reported by <code className="font-mono">docker stats</code>.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Container</th>
                        <th className="px-3 py-2 font-medium">CPU</th>
                        <th className="px-3 py-2 font-medium">Memory</th>
                        <th className="px-3 py-2 font-medium">Mem %</th>
                        <th className="px-3 py-2 font-medium">Net I/O</th>
                        <th className="px-3 py-2 font-medium">Block I/O</th>
                        <th className="px-3 py-2 font-medium">PIDs</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y font-mono">
                      {d.containers.map((c) => (
                        <tr key={c.id || c.name} className="hover:bg-muted/20">
                          <td className="px-3 py-2 font-medium text-foreground">{c.name}</td>
                          <td className="px-3 py-2">{c.cpuPercent}</td>
                          <td className="px-3 py-2">{c.memUsage}</td>
                          <td className="px-3 py-2">{c.memPercent}</td>
                          <td className="px-3 py-2 text-muted-foreground">{c.netIO}</td>
                          <td className="px-3 py-2 text-muted-foreground">{c.blockIO}</td>
                          <td className="px-3 py-2 text-muted-foreground">{c.pids}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </PageBody>
      <AskMonitorClaudeDialog
        open={asking}
        onOpenChange={setAsking}
        onStarted={(id) => void navigate({ to: '/claude/$id', params: { id } })}
      />
    </>
  )
}

function AskMonitorClaudeDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; onStarted: (id: string) => void }) {
  const [prompt, setPrompt] = useState('Inspect the server metrics, Dokploy hosted apps, and running Docker containers with hosting_monitor and hosting_list, and give me a health report with any optimization recommendations.')
  const ask = useMutation({
    mutationFn: () => unwrap(api.api.monitor.ask.$post({ json: { prompt } })),
    onSuccess: (r) => {
      onOpenChange(false)
      onStarted(r.sessionId)
    },
  })
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Diagnose Server & Hosted Apps with Claude Code"
      description="Starts a real Claude Code session with live access to hosting_monitor, hosting_list, hosting_get, hosting_logs, and services_list.">
      <form onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) ask.mutate() }}>
        <FieldGroup>
          <Textarea autoFocus rows={4} required value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <ErrorAlert error={ask.error} />
          <Button type="submit" className="h-10" disabled={!prompt.trim() || ask.isPending}>
            <Activity />{ask.isPending ? 'Starting Claude Code…' : 'Start Server Diagnosis'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
