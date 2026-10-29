import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Activity, Clock, Cpu, Database, ExternalLink, FileText, Globe, Layers, Play, Plus, RefreshCw, Rocket, Sparkles, Square } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { FieldGroup } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { lightOf } from '../hosting/HostingPage'

export const monitorQuery = queryOptions({
  queryKey: ['monitor'],
  queryFn: () => unwrap(api.api.monitor.$get()),
  refetchInterval: 4_000,
})

function Sparkline({ values, max = 100, height = 44 }: { values: number[]; max?: number; height?: number }) {
  if (!values.length) return <div className="w-full rounded bg-muted/30" style={{ height }} />
  const pts = values.length === 1 ? [values[0]!, values[0]!] : values
  const top = Math.max(max, ...pts, 1)
  const w = 220
  const h = height
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * w
    const y = h - Math.min(1, Math.max(0, v / top)) * (h - 8) - 4
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = `M ${coords.join(' L ')}`
  const area = `${line} L ${w},${h} L 0,${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full overflow-visible" style={{ height }} preserveAspectRatio="none">
      <path d={area} className="fill-foreground/10" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.75" className="text-foreground" />
    </svg>
  )
}

type FilterKind = 'all' | 'application' | 'compose' | 'database'
type FilterState = 'all' | 'healthy' | 'unhealthy' | 'stopped'

export function MonitorPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(monitorQuery)
  const [kindFilter, setKindFilter] = useState<FilterKind>('all')
  const [stateFilter, setStateFilter] = useState<FilterState>('all')
  const [askingPrompt, setAskingPrompt] = useState<string | null>(null)
  const [inspectDep, setInspectDep] = useState<{ deploymentId: string; kind: string; appId: string; appName: string } | null>(null)

  const act = useMutation({
    mutationFn: (p: { kind: string; id: string; action: 'deploy' | 'redeploy' | 'start' | 'stop' }) =>
      unwrap(api.api.hosting.apps[':kind'][':id'][':action'].$post({ param: p })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['monitor'] })
      void qc.invalidateQueries({ queryKey: ['hosting'] })
    },
  })

  const d = q.data
  const items = (d?.items ?? []).filter((item) => {
    if (kindFilter === 'application' && item.kind !== 'application') return false
    if (kindFilter === 'compose' && item.kind !== 'compose') return false
    if (kindFilter === 'database' && (item.kind === 'application' || item.kind === 'compose')) return false
    const isRunning = item.status === 'done' || item.status === 'running'
    if (stateFilter === 'healthy' && !(item.probe.reachable && item.status !== 'error')) return false
    if (stateFilter === 'unhealthy' && !(item.status === 'error' || (isRunning && !item.probe.reachable))) return false
    if (stateFilter === 'stopped' && !(item.status === 'idle' || item.status === 'stopped')) return false
    return true
  })

  const fleetLatencies = (d?.fleetHistory ?? []).map((s) => s.avgLatencyMs)
  const maxFleetLatency = Math.max(50, ...fleetLatencies)

  return (
    <>
      <PageHeader
        title="Hosted Monitor"
        description="Live endpoint health, response latency, container resources, and logs for your hosted apps, compose stacks, and databases"
        actions={<div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching} aria-label="Refresh">
            <RefreshCw className={q.isFetching ? 'animate-spin' : ''} />
          </Button>
          <Button asChild size="sm" variant="outline"><Link to="/hosting"><Rocket />Hosting</Link></Button>
          <Button
            size="sm"
            onClick={() =>
              setAskingPrompt(
                'Inspect all my hosted applications, compose stacks, and databases using hosting_monitor, hosting_list, and hosting_get. Check their HTTP/TCP response times, container status, and deployment logs, and report any issues or optimizations.',
              )
            }
          >
            <Sparkles />Ask Claude
          </Button>
        </div>}
      />
      <PageBody>
        <ErrorAlert error={q.error ?? act.error} />
        {q.isPending && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
          </div>
        )}
        {d && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Rocket className="size-3.5" />Hosted Services</span>
                  <span className="font-mono text-lg font-semibold">{d.summary.running} / {d.summary.total}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 py-1">
                  <Badge variant="secondary" className="font-mono text-[11px]">{d.summary.appsCount} apps</Badge>
                  <Badge variant="secondary" className="font-mono text-[11px]">{d.summary.composeCount} compose</Badge>
                  <Badge variant="secondary" className="font-mono text-[11px]">{d.summary.databasesCount} dbs</Badge>
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{d.summary.running} running</span>
                  <span>{d.summary.stopped} stopped</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Activity className="size-3.5" />Endpoint Health</span>
                  <span className="font-mono text-lg font-semibold">{d.summary.overallUptimePercent}%</span>
                </div>
                <div className="my-auto flex flex-col gap-1.5 py-1">
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-foreground transition-all" style={{ width: `${Math.min(100, d.summary.overallUptimePercent)}%` }} />
                  </div>
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{d.summary.healthy} healthy</span>
                  <span>{d.summary.unhealthy} degraded / error</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Clock className="size-3.5" />Avg Response Time</span>
                  <span className="font-mono text-lg font-semibold">{d.summary.avgLatencyMs} ms</span>
                </div>
                <Sparkline values={fleetLatencies} max={maxFleetLatency} height={40} />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Live HTTP / TCP probes</span>
                  <span>Every 4s</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Globe className="size-3.5" />Domains &amp; Ingress</span>
                  <span className="font-mono text-lg font-semibold">{d.summary.domainsCount}</span>
                </div>
                <div className="flex items-center gap-2 py-1 text-xs">
                  <StatusLight state={d.hosting.reachable ? 'live' : 'error'} />
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {d.hosting.reachable ? 'Dokploy :3010 · Traefik :8880/:8843' : 'Dokploy Engine Offline'}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{d.hosting.domain ? `*.${d.hosting.domain}` : 'traefik.me / custom'}</span>
                  <Link to="/hosting" className="underline underline-offset-4 hover:text-foreground">Manage</Link>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <ToggleGroup type="single" variant="outline" size="sm" value={kindFilter} onValueChange={(v) => v && setKindFilter(v as FilterKind)}>
                  <ToggleGroupItem value="all">All ({d.items.length})</ToggleGroupItem>
                  <ToggleGroupItem value="application">Apps ({d.summary.appsCount})</ToggleGroupItem>
                  <ToggleGroupItem value="compose">Compose ({d.summary.composeCount})</ToggleGroupItem>
                  <ToggleGroupItem value="database">Databases ({d.summary.databasesCount})</ToggleGroupItem>
                </ToggleGroup>
                <ToggleGroup type="single" variant="outline" size="sm" value={stateFilter} onValueChange={(v) => v && setStateFilter(v as FilterState)}>
                  <ToggleGroupItem value="all">Any status</ToggleGroupItem>
                  <ToggleGroupItem value="healthy">Healthy ({d.summary.healthy})</ToggleGroupItem>
                  <ToggleGroupItem value="unhealthy">Unhealthy ({d.summary.unhealthy})</ToggleGroupItem>
                  <ToggleGroupItem value="stopped">Stopped ({d.summary.stopped})</ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            {!d.items.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Activity /></EmptyMedia>
                  <EmptyTitle>No hosted applications or databases to monitor yet</EmptyTitle>
                  <EmptyDescription>
                    Deploy an application, a Docker Compose stack, or a managed database in Hosting, and its live HTTP/TCP response times, uptime, container CPU/RAM, and logs will appear here automatically.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="flex-row flex-wrap justify-center gap-2">
                  <Button asChild><Link to="/hosting"><Plus />Deploy in Hosting</Link></Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setAskingPrompt('Create and deploy a new web app in Dokploy using hosting_create, then verify its live status with hosting_monitor.')
                    }
                  >
                    <Sparkles />Ask Claude to Host an App
                  </Button>
                </EmptyContent>
              </Empty>
            ) : !items.length ? (
              <p className="rounded-xl border px-4 py-6 text-center text-xs text-muted-foreground">
                No hosted services match the selected filter.
              </p>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {items.map((item) => {
                  const latencies = item.history.map((h) => h.latencyMs)
                  const maxLat = Math.max(50, ...latencies)
                  const isRunning = item.status === 'done' || item.status === 'running'
                  const isDb = item.kind !== 'application' && item.kind !== 'compose'
                  return (
                    <div key={`${item.kind}:${item.id}`} className="flex flex-col justify-between gap-3 rounded-xl border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusLight state={lightOf(item.status)} />
                            <Link
                              to="/hosting/$kind/$id"
                              params={{ kind: item.kind, id: item.id }}
                              className="truncate font-medium hover:underline underline-offset-4"
                            >
                              {item.name}
                            </Link>
                            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                              {isDb ? <Database className="mr-1 size-2.5" /> : item.kind === 'compose' ? <Layers className="mr-1 size-2.5" /> : null}
                              {item.kind}
                            </Badge>
                            <Badge variant="outline" className="font-mono text-[10px] capitalize">{item.status}</Badge>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{item.project} · {item.environment}</span>
                            <span className="font-mono text-[11px]">({item.appName})</span>
                            {item.url && (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground underline underline-offset-4"
                              >
                                {item.url}<ExternalLink className="size-2.5" />
                              </a>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <Badge variant={item.probe.reachable ? 'secondary' : 'outline'} className="font-mono text-[11px]">
                            {item.probe.reachable
                              ? `${item.probe.statusCode ? `HTTP ${item.probe.statusCode} · ` : ''}${item.probe.latencyMs} ms`
                              : item.status === 'idle'
                              ? 'Stopped'
                              : 'Unreachable'}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            Uptime {item.probe.uptimePercent}%
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border bg-background/50 p-2.5">
                          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>Response Latency ({item.probe.protocol.toUpperCase()})</span>
                            <span className="font-mono text-foreground">{item.probe.latencyMs} ms</span>
                          </div>
                          <Sparkline values={latencies} max={maxLat} height={36} />
                          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                            Target: {item.probe.target}
                          </div>
                        </div>

                        <div className="flex flex-col justify-between rounded-lg border bg-background/50 p-2.5 text-xs">
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="flex items-center gap-1"><Cpu className="size-3" />Container Telemetry</span>
                            <span className="font-mono text-foreground">{item.resources.cpuText}</span>
                          </div>
                          <div className="my-1 grid grid-cols-2 gap-1 font-mono text-[11px]">
                            <div>
                              <span className="text-muted-foreground">RAM: </span>
                              <span>{item.resources.memUsage.split('/')[0]?.trim() || '0 B'}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">PIDs: </span>
                              <span>{item.resources.pids}</span>
                            </div>
                            <div className="col-span-2 truncate text-[10px] text-muted-foreground">
                              Net I/O: {item.resources.netIO}
                            </div>
                          </div>
                        </div>
                      </div>

                      {item.lastDeployment && (
                        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs">
                          <span className="truncate text-muted-foreground">
                            Last deploy: <strong className="text-foreground">{item.lastDeployment.title}</strong> ({item.lastDeployment.status})
                          </span>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setInspectDep({
                                deploymentId: item.lastDeployment!.id,
                                kind: item.kind,
                                appId: item.id,
                                appName: item.name,
                              })
                            }
                          >
                            <FileText className="size-3" />Logs
                          </Button>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ kind: item.kind, id: item.id, action: 'redeploy' })}
                          >
                            <RefreshCw className="size-3" />Redeploy
                          </Button>
                          {isRunning ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={act.isPending}
                              onClick={() => act.mutate({ kind: item.kind, id: item.id, action: 'stop' })}
                            >
                              <Square className="size-3" />Stop
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={act.isPending}
                              onClick={() => act.mutate({ kind: item.kind, id: item.id, action: 'start' })}
                            >
                              <Play className="size-3" />Start
                            </Button>
                          )}
                          <Button asChild size="xs" variant="ghost">
                            <Link to="/hosting/$kind/$id" params={{ kind: item.kind, id: item.id }}>Configure</Link>
                          </Button>
                        </div>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            setAskingPrompt(
                              `Inspect my hosted ${item.kind} "${item.name}" (id: "${item.id}", kind: "${item.kind}") using hosting_get, hosting_logs, and hosting_monitor. Check its health, latency, configuration, and logs, and fix or optimize anything needed.`,
                            )
                          }
                        >
                          <Sparkles className="size-3" />Diagnose with Claude
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </PageBody>

      <AskMonitorClaudeDialog
        prompt={askingPrompt}
        onOpenChange={(o) => { if (!o) setAskingPrompt(null) }}
        onStarted={(id) => void navigate({ to: '/claude/$id', params: { id } })}
      />

      <InspectDeploymentLogsDialog
        target={inspectDep}
        onOpenChange={(o) => { if (!o) setInspectDep(null) }}
        onStarted={(id) => void navigate({ to: '/claude/$id', params: { id } })}
      />
    </>
  )
}

function InspectDeploymentLogsDialog({
  target,
  onOpenChange,
  onStarted,
}: {
  target: { deploymentId: string; kind: string; appId: string; appName: string } | null
  onOpenChange: (o: boolean) => void
  onStarted: (id: string) => void
}) {
  const logs = useQuery({
    queryKey: ['hosting', 'logs', target?.deploymentId],
    enabled: !!target,
    refetchInterval: 3_000,
    queryFn: () => unwrap(api.api.hosting.deployments[':id'].logs.$get({ param: { id: target!.deploymentId } })),
  })

  const analyze = useMutation({
    mutationFn: () =>
      unwrap(
        api.api.hosting.deployments[':id'].analyze.$post({
          param: { id: target!.deploymentId },
          json: { kind: target!.kind as 'application', appId: target!.appId, appName: target!.appName },
        }),
      ),
    onSuccess: (r) => {
      onOpenChange(false)
      onStarted(r.sessionId)
    },
  })

  return (
    <ResponsiveDialog
      open={!!target}
      onOpenChange={onOpenChange}
      title={target ? `Logs · ${target.appName}` : 'Deployment Logs'}
      description="Live output from the bundled Dokploy engine."
    >
      <div className="flex flex-col gap-3">
        <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
          {logs.isPending ? 'Loading logs…' : logs.data?.logs || 'No log output yet.'}
        </pre>
        <ErrorAlert error={logs.error ?? analyze.error} />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void logs.refetch()} disabled={logs.isFetching}>
            <RefreshCw className={logs.isFetching ? 'animate-spin' : ''} />Refresh
          </Button>
          <Button size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || !target}>
            <Sparkles />{analyze.isPending ? 'Starting Claude Code…' : 'AI Analyze Logs with Claude Code'}
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  )
}

function AskMonitorClaudeDialog({
  prompt,
  onOpenChange,
  onStarted,
}: {
  prompt: string | null
  onOpenChange: (o: boolean) => void
  onStarted: (id: string) => void
}) {
  const [text, setText] = useState(prompt ?? '')
  if (prompt !== null && text === '' && prompt !== '') {
    setText(prompt)
  }
  const ask = useMutation({
    mutationFn: () => unwrap(api.api.monitor.ask.$post({ json: { prompt: text || prompt || '' } })),
    onSuccess: (r) => {
      setText('')
      onOpenChange(false)
      onStarted(r.sessionId)
    },
  })
  return (
    <ResponsiveDialog
      open={prompt !== null}
      onOpenChange={(o) => {
        if (!o) setText('')
        onOpenChange(o)
      }}
      title="Monitor & Diagnose Hosted Services with Claude Code"
      description="Starts a real Claude Code session with live access to hosting_monitor, hosting_list, hosting_get, hosting_logs, hosting_update, and hosting_action."
    >
      <form onSubmit={(e) => { e.preventDefault(); ask.mutate() }}>
        <FieldGroup>
          <Textarea autoFocus rows={4} required value={text || prompt || ''} onChange={(e) => setText(e.target.value)} />
          <ErrorAlert error={ask.error} />
          <Button type="submit" className="h-10" disabled={!(text || prompt || '').trim() || ask.isPending}>
            <Sparkles />{ask.isPending ? 'Starting Claude Code…' : 'Start Claude Code Diagnosis'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
