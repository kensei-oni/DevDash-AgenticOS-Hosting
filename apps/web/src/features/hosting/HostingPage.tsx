import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Activity, Database, ExternalLink, Globe, LayoutDashboard, Pencil, Play, Plus, RefreshCw, Rocket, Sparkles, Square, Trash2, X } from 'lucide-react'
import { StatusLight, type LightState } from '@/components/app/brand'
import { confirmAction } from '@/components/app/confirm'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'

type Kind = 'application' | 'compose' | 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'
type DbKind = 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'

export const hostingStatusQuery = queryOptions({
  queryKey: ['hosting', 'status'],
  queryFn: () => unwrap(api.api.hosting.status.$get()),
  staleTime: 15_000,
})
const appsQuery = queryOptions({
  queryKey: ['hosting', 'apps'],
  queryFn: () => unwrap(api.api.hosting.apps.$get()),
  refetchInterval: 10_000,
})
const appQuery = (kind: Kind, id: string) => queryOptions({
  queryKey: ['hosting', 'app', kind, id],
  queryFn: () => unwrap(api.api.hosting.apps[':kind'][':id'].$get({ param: { kind, id } })),
  refetchInterval: 5_000,
})

/** Dokploy's statuses as the app's status lights. */
export function lightOf(status: string): LightState {
  if (status === 'done' || status === 'running') return 'live'
  if (status === 'error') return 'error'
  if (status === 'queued' || status === 'building') return 'waiting'
  return 'idle'
}

export function HostingPage() {
  const status = useQuery(hostingStatusQuery)
  const ready = status.data?.configured && status.data.reachable
  const apps = useQuery({ ...appsQuery, enabled: !!ready })
  const [adding, setAdding] = useState(false)
  const [addingDb, setAddingDb] = useState(false)
  const [asking, setAsking] = useState(false)
  const [view, setView] = useState<'native' | 'studio'>('native')
  const all = apps.data?.apps ?? []

  return (
    <>
      <PageHeader title="Hosting" description="Full Dokploy engine embedded in agOS (port 3010 · Traefik 8880/8843) with real Claude Code integration"
        actions={<div className="flex flex-wrap items-center gap-1.5">
          <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => v && setView(v as 'native' | 'studio')}>
            <ToggleGroupItem value="native">agOS View</ToggleGroupItem>
            <ToggleGroupItem value="studio"><LayoutDashboard className="size-3.5 mr-1" />Dokploy Studio</ToggleGroupItem>
          </ToggleGroup>
          <Button asChild size="sm" variant="ghost"><Link to="/monitor"><Activity />Monitor</Link></Button>
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}><Sparkles />Ask Claude</Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => setAddingDb(true)}><Database />+ DB</Button>
          <Button size="sm" disabled={!ready} onClick={() => setAdding(true)}><Plus />Deploy</Button>
        </div>} />
      {view === 'studio' && status.data ? (
        <DokployStudioView
          status={status.data}
          ready={!!ready}
          onDeploy={() => setAdding(true)}
          onAddDb={() => setAddingDb(true)}
          onAskClaude={() => setAsking(true)}
        />
      ) : (
      <PageBody>
        <ErrorAlert error={status.error ?? apps.error} />
        {status.isPending && <Skeleton className="h-16" />}
        {status.data && !ready && <SetupHelp s={status.data} />}
        {status.data && ready && (
          <div className="flex flex-wrap items-center justify-between gap-2 -mt-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <StatusLight state="live" />
              <span>Bundled Dokploy engine active ({status.data.url}) · Traefik :8880/:8843</span>
              {status.data.domain && <Badge variant="secondary" className="font-mono text-[11px]">*.{status.data.domain}</Badge>}
            </div>
            <div className="flex items-center gap-3">
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setView('studio')}>
                Open embedded Dokploy Studio
              </Button>
              {status.data.dashboardUrl && (
                <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
                  <a href={status.data.dashboardUrl} target="_blank" rel="noreferrer">New tab<ExternalLink className="size-3" /></a>
                </Button>
              )}
            </div>
          </div>
        )}
        {ready && apps.isPending && <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {ready && apps.isSuccess && !all.length && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><Rocket /></EmptyMedia>
              <EmptyTitle>Nothing hosted yet</EmptyTitle>
              <EmptyDescription>
                Deploy a git repository, a Docker image, a Compose stack, or a managed database (Postgres, MySQL, MariaDB, MongoDB, Redis) on the bundled Dokploy engine — or ask Claude Code to create, configure and deploy it for you.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row flex-wrap justify-center gap-2">
              <Button onClick={() => setAdding(true)}><Plus />Deploy App / Compose</Button>
              <Button variant="outline" onClick={() => setAddingDb(true)}><Database />Create Database</Button>
              <Button variant="outline" onClick={() => setAsking(true)}><Sparkles />Ask Claude</Button>
            </EmptyContent>
          </Empty>
        )}
        {all.length > 0 && (
          <ItemGroup className="gap-2">
            {all.map((a) => (
              <Item key={a.id} variant="outline" asChild>
                <Link to="/hosting/$kind/$id" params={{ kind: a.kind, id: a.id }}>
                  <ItemMedia><StatusLight state={lightOf(a.status)} label={a.status} /></ItemMedia>
                  <ItemContent>
                    <ItemTitle>{a.name}</ItemTitle>
                    <ItemDescription>
                      {a.project} · {a.environment} · <span className="capitalize">{a.kind === 'compose' ? 'Compose stack' : a.kind}</span>
                      {a.url ? ` · ${a.url}` : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions><span className="text-xs text-muted-foreground capitalize">{a.status}</span></ItemActions>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        )}
      </PageBody>
      )}
      <DeployDialog open={adding} onOpenChange={setAdding} domain={status.data?.domain ?? null} />
      <CreateDatabaseDialog open={addingDb} onOpenChange={setAddingDb} />
      <AskClaudeDialog open={asking} onOpenChange={setAsking} />
    </>
  )
}

function SetupHelp({ s }: { s: { url: string; error: string | null } }) {
  return (
    <Alert>
      <Rocket />
      <AlertTitle>Bundled Dokploy engine at {s.url} is not running yet</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{s.error}</p>
        <p className="text-xs text-muted-foreground">
          Dokploy runs beside agOS in <code className="font-mono">apps/hosting</code> on port <code className="font-mono">3010</code> (with Traefik on <code className="font-mono">8880</code>/<code className="font-mono">8843</code>) and authenticates automatically with agOS's <code className="font-mono">DEVDASH_MASTER_KEY</code>. Restart <code className="font-mono">npm run dev:server</code> or run <code className="font-mono">sudo bash deploy/hosting-install.sh</code>.
        </p>
      </AlertDescription>
    </Alert>
  )
}

type StudioTab = 'projects' | 'traefik' | 'docker' | 'registries' | 'servers' | 'api' | 'webui'

function DokployStudioView({
  status,
  ready,
  onDeploy,
  onAddDb,
  onAskClaude,
}: {
  status: { url: string; dashboardUrl: string | null; domain: string | null; error: string | null }
  ready: boolean
  onDeploy: () => void
  onAddDb: () => void
  onAskClaude: () => void
}) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<StudioTab>('projects')
  const [newProjName, setNewProjName] = useState('')
  const [traefikDraft, setTraefikDraft] = useState<string | null>(null)
  const [regName, setRegName] = useState('')
  const [regUrl, setRegUrl] = useState('ghcr.io')
  const [regUser, setRegUser] = useState('')
  const [s3Name, setS3Name] = useState('')
  const [s3Bucket, setS3Bucket] = useState('')
  const [s3Endpoint, setS3Endpoint] = useState('https://s3.amazonaws.com')
  const [srvName, setSrvName] = useState('')
  const [srvIp, setSrvIp] = useState('')
  const [apiProc, setApiProc] = useState('settings.getDokployVersion')
  const [apiInput, setApiInput] = useState('{}')
  const [apiResult, setApiResult] = useState<string | null>(null)

  const callDokploy = (procedure: string, input?: Record<string, unknown>, method?: 'GET' | 'POST') =>
    unwrap(api.api.hosting.dokploy.$post({ json: { procedure, input, method } })).then((r) => r.result)

  const projectsQ = useQuery({
    queryKey: ['hosting', 'studio', 'projects'],
    enabled: ready && tab === 'projects',
    queryFn: () => callDokploy('project.all', undefined, 'GET') as Promise<any[]>,
  })
  const traefikQ = useQuery({
    queryKey: ['hosting', 'studio', 'traefik'],
    enabled: ready && tab === 'traefik',
    queryFn: () => callDokploy('settings.readTraefikConfig', undefined, 'GET') as Promise<{ config?: string }>,
  })
  const dockerQ = useQuery({
    queryKey: ['hosting', 'studio', 'docker'],
    enabled: ready && tab === 'docker',
    queryFn: () => callDokploy('docker.getContainers', undefined, 'GET') as Promise<any[]>,
  })
  const registriesQ = useQuery({
    queryKey: ['hosting', 'studio', 'registries'],
    enabled: ready && tab === 'registries',
    queryFn: async () => {
      const [regs, dests] = await Promise.all([
        callDokploy('registry.all', undefined, 'GET') as Promise<any[]>,
        callDokploy('destination.all', undefined, 'GET') as Promise<any[]>,
      ])
      return { regs: regs ?? [], dests: dests ?? [] }
    },
  })
  const serversQ = useQuery({
    queryKey: ['hosting', 'studio', 'servers'],
    enabled: ready && tab === 'servers',
    queryFn: () => callDokploy('server.all', undefined, 'GET') as Promise<any[]>,
  })

  const createProject = useMutation({
    mutationFn: () => callDokploy('project.create', { name: newProjName.trim() }, 'POST'),
    onSuccess: () => {
      setNewProjName('')
      void qc.invalidateQueries({ queryKey: ['hosting'] })
    },
  })
  const removeProject = useMutation({
    mutationFn: (projectId: string) => callDokploy('project.remove', { projectId }, 'POST'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hosting'] }),
  })
  const saveTraefik = useMutation({
    mutationFn: () => callDokploy('settings.updateTraefikConfig', { traefikConfig: traefikDraft ?? traefikQ.data?.config ?? '' }, 'POST'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hosting', 'studio', 'traefik'] }),
  })
  const pruneImages = useMutation({
    mutationFn: () => callDokploy('settings.cleanUnusedImages', {}, 'POST'),
    onSuccess: () => void dockerQ.refetch(),
  })
  const addRegistry = useMutation({
    mutationFn: () => callDokploy('registry.create', { registryName: regName, registryUrl: regUrl, username: regUser }, 'POST'),
    onSuccess: () => {
      setRegName(''); setRegUser('')
      void registriesQ.refetch()
    },
  })
  const addDestination = useMutation({
    mutationFn: () => callDokploy('destination.create', { name: s3Name, bucket: s3Bucket, endpoint: s3Endpoint }, 'POST'),
    onSuccess: () => {
      setS3Name(''); setS3Bucket('')
      void registriesQ.refetch()
    },
  })
  const addServer = useMutation({
    mutationFn: () => callDokploy('server.create', { name: srvName, ipAddress: srvIp }, 'POST'),
    onSuccess: () => {
      setSrvName(''); setSrvIp('')
      void serversQ.refetch()
    },
  })
  const runApi = useMutation({
    mutationFn: async () => {
      const parsed = apiInput.trim() ? JSON.parse(apiInput) : undefined
      const res = await callDokploy(apiProc.trim(), parsed)
      setApiResult(JSON.stringify(res, null, 2))
    },
  })

  return (
    <PageBody>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3.5 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <StatusLight state={ready ? 'live' : 'error'} />
          <span className="font-medium">Full Dokploy Studio (agOS monochrome theme · port 3010 · Traefik :8880/:8843)</span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={status.dashboardUrl || status.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-mono text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {status.dashboardUrl || status.url}<ExternalLink className="size-3" />
          </a>
        </div>
      </div>

      {!ready ? (
        <SetupHelp s={status} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={tab} onValueChange={(v) => v && setTab(v as StudioTab)}>
              <ToggleGroupItem value="projects">Projects &amp; Services</ToggleGroupItem>
              <ToggleGroupItem value="traefik">Traefik (:8880/:8843)</ToggleGroupItem>
              <ToggleGroupItem value="docker">Docker Containers</ToggleGroupItem>
              <ToggleGroupItem value="registries">Registries &amp; S3 Backups</ToggleGroupItem>
              <ToggleGroupItem value="servers">Cluster Nodes</ToggleGroupItem>
              <ToggleGroupItem value="api">API Console</ToggleGroupItem>
              <ToggleGroupItem value="webui">Port :3010 Web UI</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {tab === 'projects' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3.5">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-9 w-52 font-mono text-xs"
                    placeholder="new-project-name"
                    value={newProjName}
                    onChange={(e) => setNewProjName(e.target.value)}
                  />
                  <Button size="sm" disabled={!newProjName.trim() || createProject.isPending} onClick={() => createProject.mutate()}>
                    <Plus />Create Project
                  </Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={onDeploy}><Plus />Deploy App / Compose</Button>
                  <Button size="sm" variant="outline" onClick={onAddDb}><Database />+ Managed DB</Button>
                  <Button size="sm" variant="outline" onClick={onAskClaude}><Sparkles />Ask Claude</Button>
                </div>
              </div>

              {projectsQ.isPending && <Skeleton className="h-32" />}
              {(projectsQ.data ?? []).map((p: any) => {
                const envs = p.environments ?? []
                const services = envs.flatMap((e: any) => [
                  ...(e.applications ?? []).map((a: any) => ({ kind: 'application' as Kind, id: a.applicationId, name: a.name, appName: a.appName, status: a.applicationStatus ?? 'idle', env: e.name })),
                  ...(e.compose ?? []).map((c: any) => ({ kind: 'compose' as Kind, id: c.composeId, name: c.name, appName: c.appName, status: c.composeStatus ?? 'idle', env: e.name })),
                  ...(['postgres', 'mysql', 'mariadb', 'mongo', 'redis'] as const).flatMap((k) =>
                    (e[k] ?? []).map((d: any) => ({ kind: k as Kind, id: d[`${k}Id`] ?? d.dbId, name: d.name, appName: d.appName, status: d.applicationStatus ?? 'idle', env: e.name })),
                  ),
                ])
                return (
                  <div key={p.projectId} className="rounded-xl border bg-card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="font-medium">{p.name}</h3>
                        <p className="text-xs text-muted-foreground">{envs.length} environment(s) · {services.length} service(s)</p>
                      </div>
                      {p.name !== 'default' && (
                        <Button size="xs" variant="ghost" onClick={() => removeProject.mutate(p.projectId)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                    {services.length > 0 && (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {services.map((s: any) => (
                          <Link
                            key={`${s.kind}:${s.id}`}
                            to="/hosting/$kind/$id"
                            params={{ kind: s.kind, id: s.id }}
                            className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-xs hover:bg-muted/40"
                          >
                            <span className="flex items-center gap-2">
                              <StatusLight state={lightOf(s.status)} />
                              <strong className="font-medium">{s.name}</strong>
                              <span className="font-mono text-[11px] text-muted-foreground">({s.kind})</span>
                            </span>
                            <Badge variant="secondary" className="font-mono text-[10px] capitalize">{s.status}</Badge>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'traefik' && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Traefik Reverse Proxy Configuration (:8880 HTTP / :8843 HTTPS)</h3>
                  <p className="text-xs text-muted-foreground">Live static configuration read from the bundled Dokploy engine</p>
                </div>
                <Button size="sm" onClick={() => saveTraefik.mutate()} disabled={saveTraefik.isPending}>
                  {saveTraefik.isPending ? 'Saving…' : 'Save Traefik Config'}
                </Button>
              </div>
              <Textarea
                rows={16}
                className="font-mono text-xs"
                value={traefikDraft ?? traefikQ.data?.config ?? ''}
                onChange={(e) => setTraefikDraft(e.target.value)}
              />
            </div>
          )}

          {tab === 'docker' && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Docker Engine Containers</h3>
                  <p className="text-xs text-muted-foreground">Live containers managed via Dokploy docker.getContainers</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => pruneImages.mutate()} disabled={pruneImages.isPending}>
                    Prune Unused Images
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void dockerQ.refetch()}>
                    <RefreshCw className={dockerQ.isFetching ? 'animate-spin' : ''} />
                  </Button>
                </div>
              </div>
              {!(dockerQ.data ?? []).length ? (
                <p className="rounded-lg border px-3 py-4 text-xs text-muted-foreground">No Docker containers reported by docker ps.</p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {(dockerQ.data ?? []).map((c: any) => (
                    <div key={c.containerId || c.name} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div>
                        <span className="font-mono font-medium">{c.name}</span>
                        <span className="ml-2 text-muted-foreground">{c.image} · {c.status}</span>
                      </div>
                      <Badge variant="secondary" className="font-mono text-[10px]">{c.state}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'registries' && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
                <h3 className="font-medium">Container Registries (GHCR / Docker Hub / ECR)</h3>
                <div className="grid gap-2">
                  <Input placeholder="Registry Name (e.g. GHCR)" value={regName} onChange={(e) => setRegName(e.target.value)} />
                  <Input placeholder="Registry URL (e.g. ghcr.io)" value={regUrl} onChange={(e) => setRegUrl(e.target.value)} />
                  <Input placeholder="Username" value={regUser} onChange={(e) => setRegUser(e.target.value)} />
                  <Button size="sm" disabled={!regName.trim() || addRegistry.isPending} onClick={() => addRegistry.mutate()}>
                    <Plus />Add Registry
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {(registriesQ.data?.regs ?? []).map((r: any) => (
                    <div key={r.registry_id || r.registryId} className="flex items-center justify-between rounded border px-2.5 py-1.5 text-xs font-mono">
                      <span>{r.registry_name || r.registryName} ({r.registry_url || r.registryUrl})</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
                <h3 className="font-medium">S3 Backup Destinations</h3>
                <div className="grid gap-2">
                  <Input placeholder="Destination Name (e.g. Nightly S3)" value={s3Name} onChange={(e) => setS3Name(e.target.value)} />
                  <Input placeholder="Bucket Name" value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} />
                  <Input placeholder="Endpoint URL" value={s3Endpoint} onChange={(e) => setS3Endpoint(e.target.value)} />
                  <Button size="sm" disabled={!s3Name.trim() || !s3Bucket.trim() || addDestination.isPending} onClick={() => addDestination.mutate()}>
                    <Plus />Add S3 Destination
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {(registriesQ.data?.dests ?? []).map((d: any) => (
                    <div key={d.destination_id || d.destinationId} className="flex items-center justify-between rounded border px-2.5 py-1.5 text-xs font-mono">
                      <span>{d.name} ({d.bucket})</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'servers' && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <h3 className="font-medium">Remote Deployment Servers &amp; Swarm Nodes</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Input className="h-9 w-48 text-xs" placeholder="Node Name (e.g. worker-1)" value={srvName} onChange={(e) => setSrvName(e.target.value)} />
                <Input className="h-9 w-48 font-mono text-xs" placeholder="IP Address" value={srvIp} onChange={(e) => setSrvIp(e.target.value)} />
                <Button size="sm" disabled={!srvName.trim() || !srvIp.trim() || addServer.isPending} onClick={() => addServer.mutate()}>
                  <Plus />Add Server Node
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-xs">
                  <span className="flex items-center gap-2 font-medium"><StatusLight state="live" />Local Bundled Dokploy Engine (127.0.0.1:3010)</span>
                  <Badge variant="secondary" className="font-mono text-[10px]">primary</Badge>
                </div>
                {(serversQ.data ?? []).map((s: any) => (
                  <div key={s.server_id || s.serverId} className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-xs">
                    <span><strong>{s.name}</strong> ({s.ip_address || s.ipAddress})</span>
                    <Badge variant="outline" className="font-mono text-[10px]">{s.server_status || 'active'}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'api' && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <h3 className="font-medium">Direct Dokploy tRPC / API Console</h3>
              <p className="text-xs text-muted-foreground">Invoke any Dokploy router procedure (&lt;router&gt;.&lt;procedure&gt;) directly against port 3010</p>
              <div className="flex items-center gap-2">
                <Input className="font-mono text-xs" value={apiProc} onChange={(e) => setApiProc(e.target.value)} placeholder="settings.getDokployVersion" />
                <Button size="sm" onClick={() => runApi.mutate()} disabled={runApi.isPending}>Execute</Button>
              </div>
              <Textarea rows={4} className="font-mono text-xs" value={apiInput} onChange={(e) => setApiInput(e.target.value)} />
              <ErrorAlert error={runApi.error} />
              {apiResult && (
                <pre className="max-h-80 overflow-auto rounded-lg border bg-background p-3 font-mono text-xs">{apiResult}</pre>
              )}
            </div>
          )}

          {tab === 'webui' && (
            <iframe
              title="Dokploy Studio (:3010)"
              src={status.dashboardUrl || status.url}
              className="min-h-[72vh] w-full rounded-xl border bg-background"
            />
          )}
        </>
      )}
    </PageBody>
  )
}

type SourceType = 'git' | 'docker' | 'compose'
const EMPTY = { name: '', type: 'git' as SourceType, url: '', branch: 'main', buildPath: '/', image: '', compose: '', buildType: 'nixpacks', port: '3000', env: '', domain: '' }

function DeployDialog({ open, onOpenChange, domain }: { open: boolean; onOpenChange: (o: boolean) => void; domain: string | null }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [f, setF] = useState(EMPTY)
  const set = (p: Partial<typeof EMPTY>) => setF((x) => ({ ...x, ...p }))
  const create = useMutation({
    mutationFn: () => unwrap(api.api.hosting.apps.$post({ json: {
      name: f.name, env: f.env || undefined, domain: f.domain || null, port: Number(f.port) || undefined,
      buildType: f.type === 'git' ? f.buildType as 'nixpacks' : undefined,
      source: f.type === 'git'
        ? { type: 'git', url: f.url, branch: f.branch || undefined, buildPath: f.buildPath || undefined }
        : f.type === 'docker'
        ? { type: 'docker', image: f.image }
        : { type: 'compose', file: f.compose },
    } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['hosting'] })
      onOpenChange(false); setF(EMPTY)
      void navigate({ to: '/hosting/$kind/$id', params: { kind: r.kind, id: r.id } })
    },
  })
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate() }
  const slug = f.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Deploy to Dokploy" description="Creates the app in the bundled Dokploy engine and deploys it right away.">
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="h-name">Name</FieldLabel>
            <Input id="h-name" required className="h-10 font-mono" placeholder="my-site" value={f.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
          </Field>
          <ToggleGroup type="single" variant="outline" size="sm" value={f.type} onValueChange={(v) => v && set({ type: v as SourceType })} aria-label="Source">
            <ToggleGroupItem value="git">Git repository</ToggleGroupItem>
            <ToggleGroupItem value="docker">Docker image</ToggleGroupItem>
            <ToggleGroupItem value="compose">Compose</ToggleGroupItem>
          </ToggleGroup>
          {f.type === 'git' && <>
            <Field>
              <FieldLabel htmlFor="h-url">Repository URL</FieldLabel>
              <Input id="h-url" required className="h-10 font-mono" placeholder="https://github.com/me/app.git" value={f.url} onChange={(e) => set({ url: e.target.value })} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="h-branch">Branch</FieldLabel>
                <Input id="h-branch" className="h-10 font-mono" value={f.branch} onChange={(e) => set({ branch: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="h-path">Build path</FieldLabel>
                <Input id="h-path" className="h-10 font-mono" placeholder="/" value={f.buildPath} onChange={(e) => set({ buildPath: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="h-build">Build</FieldLabel>
                <NativeSelect id="h-build" className="[&_select]:h-10" value={f.buildType} onChange={(e) => set({ buildType: e.target.value })}>
                  <option value="nixpacks">Nixpacks (auto)</option>
                  <option value="railpack">Railpack</option>
                  <option value="dockerfile">Dockerfile</option>
                  <option value="static">Static site</option>
                  <option value="heroku_buildpacks">Heroku buildpacks</option>
                  <option value="paketo_buildpacks">Paketo buildpacks</option>
                </NativeSelect>
              </Field>
            </div>
          </>}
          {f.type === 'docker' && (
            <Field>
              <FieldLabel htmlFor="h-image">Image</FieldLabel>
              <Input id="h-image" required className="h-10 font-mono" placeholder="nginx:alpine" value={f.image} onChange={(e) => set({ image: e.target.value })} />
            </Field>
          )}
          {f.type === 'compose' && (
            <Field>
              <FieldLabel htmlFor="h-compose">docker-compose.yml</FieldLabel>
              <Textarea id="h-compose" required rows={8} className="font-mono text-xs" value={f.compose} onChange={(e) => set({ compose: e.target.value })} />
              <FieldDescription>Add domains after creation or ask Claude Code to configure service domains.</FieldDescription>
            </Field>
          )}
          {f.type !== 'compose' && (
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <Field>
                <FieldLabel htmlFor="h-port">Port</FieldLabel>
                <Input id="h-port" inputMode="numeric" className="h-10 font-mono" value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="h-domain">Domain</FieldLabel>
                <Input id="h-domain" className="h-10 font-mono" placeholder={domain ? `${slug || 'name'}.${domain}` : 'automatic (traefik.me)'} value={f.domain} onChange={(e) => set({ domain: e.target.value })} />
              </Field>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="h-env">Environment</FieldLabel>
            <Textarea id="h-env" rows={3} className="font-mono text-xs" placeholder="KEY=value" value={f.env} onChange={(e) => set({ env: e.target.value })} />
          </Field>
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!f.name || create.isPending}><Rocket />{create.isPending ? 'Deploying…' : 'Deploy'}</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

export function AskClaudeDialog({ open, onOpenChange, initial = '' }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: string }) {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState(initial)
  useEffect(() => { if (open) setPrompt(initial) }, [open, initial])

  const ask = useMutation({
    mutationFn: () => unwrap(api.api.hosting.ask.$post({ json: { prompt } })),
    onSuccess: (r) => {
      onOpenChange(false); setPrompt('')
      void navigate({ to: '/claude/$id', params: { id: r.sessionId } })
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Ask Claude Code"
      description="Starts a real Claude Code session with built-in Dokploy hosting tools (create, edit, add/remove domains, read logs, and redeploy).">
      <form onSubmit={(e) => { e.preventDefault(); ask.mutate() }}>
        <FieldGroup>
          <Textarea autoFocus rows={4} required value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Deploy project shop to production on shop.example.com, or update my-api's environment variables and redeploy, or spin up an Uptime Kuma status page..." />
          <ErrorAlert error={ask.error} />
          <Button type="submit" className="h-10" disabled={!prompt.trim() || ask.isPending}>
            <Sparkles />{ask.isPending ? 'Starting Claude Code…' : 'Start with Claude Code'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

export function HostedAppPage({ kind, id }: { kind: Kind; id: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const me = useQuery(meQuery).data!
  const app = useQuery(appQuery(kind, id))
  const [logOf, setLogOf] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [addingDomain, setAddingDomain] = useState(false)

  const logs = useQuery({
    queryKey: ['hosting', 'logs', logOf], enabled: !!logOf, refetchInterval: 3_000,
    queryFn: () => unwrap(api.api.hosting.deployments[':id'].logs.$get({ param: { id: logOf! } })),
  })

  const analyze = useMutation({
    mutationFn: (depId: string) => unwrap(api.api.hosting.deployments[':id'].analyze.$post({
      param: { id: depId },
      json: { kind, appId: id, appName: app.data?.name },
    })),
    onSuccess: (r) => {
      void navigate({ to: '/claude/$id', params: { id: r.sessionId } })
    },
  })

  const act = useMutation({
    mutationFn: (action: 'deploy' | 'redeploy' | 'stop' | 'start' | 'delete') =>
      unwrap(api.api.hosting.apps[':kind'][':id'][':action'].$post({ param: { kind, id, action } })),
    onSuccess: (_r, action) => {
      void qc.invalidateQueries({ queryKey: ['hosting'] })
      if (action === 'delete') void navigate({ to: '/hosting' })
    },
  })

  const removeDom = useMutation({
    mutationFn: (domainId: string) => unwrap(api.api.hosting.domains[':domainId'].$delete({ param: { domainId } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hosting', 'app', kind, id] }),
  })

  const a = app.data
  const activeDepId = logOf ?? a?.deployments[0]?.id ?? null
  const activeLogs = useQuery({
    queryKey: ['hosting', 'logs', activeDepId], enabled: !!activeDepId, refetchInterval: 3_000,
    queryFn: () => unwrap(api.api.hosting.deployments[':id'].logs.$get({ param: { id: activeDepId! } })),
  })
  const failed = a?.deployments.find((d) => d.status === 'error')

  return (
    <>
      <PageHeader back="/hosting" title={a?.name ?? 'Hosted app'}
        description={a ? <span className="flex items-center gap-2"><StatusLight state={lightOf(a.status)} />{a.status} · {kind === 'compose' ? 'Compose stack' : a.buildType ?? a.source}</span> : undefined}
        actions={a && <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil />Edit</Button>
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}><Sparkles />Ask Claude</Button>
          <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('redeploy')}><RefreshCw />Redeploy</Button>
          {a.status === 'idle' ? <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('start')}><Play />Start</Button>
            : <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('stop')}><Square />Stop</Button>}
          {me.role === 'admin' && <Button size="sm" variant="ghost" disabled={act.isPending} aria-label="Delete" onClick={async () => {
            if (await confirmAction({ title: `Delete ${a.name}?`, description: 'Its containers and deployments are removed from Dokploy.', action: 'Delete', destructive: true })) act.mutate('delete')
          }}><Trash2 /></Button>}
        </div>} />
      <PageBody>
        <ErrorAlert error={app.error ?? act.error ?? analyze.error ?? removeDom.error} />
        {app.isPending && <Skeleton className="h-40" />}
        {a && <>
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Domains &amp; Public URLs</h2>
              <Button size="sm" variant="outline" onClick={() => setAddingDomain(true)}><Globe />Add domain</Button>
            </div>
            {!a.domains.length && <p className="text-sm text-muted-foreground">No domains configured yet.</p>}
            {a.domains.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {a.domains.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <a href={d.url} target="_blank" rel="noreferrer" className="font-mono underline-offset-4 hover:underline flex items-center gap-1 truncate">
                        {d.url}<ExternalLink className="size-3 shrink-0" />
                      </a>
                      {d.port && <Badge variant="secondary" className="font-mono text-[11px]">:{d.port}</Badge>}
                      {d.serviceName && <Badge variant="outline" className="font-mono text-[11px]">{d.serviceName}</Badge>}
                    </div>
                    <Button size="icon" variant="ghost" className="size-7" aria-label="Remove domain" disabled={removeDom.isPending} onClick={() => removeDom.mutate(d.id)}>
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="grid gap-1.5 rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Configuration</span>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}><Pencil className="size-3 mr-1" />Edit configuration</Button>
            </div>
            {a.repository && <div><span className="text-muted-foreground">Repository: </span><span className="font-mono">{a.repository}{a.branch ? ` @ ${a.branch}` : ''}{a.buildPath && a.buildPath !== '/' ? ` (${a.buildPath})` : ''}</span></div>}
            {a.buildType && <div><span className="text-muted-foreground">Build type: </span><span className="font-mono">{a.buildType}{a.dockerfile ? ` (${a.dockerfile})` : ''}</span></div>}
            {a.image && <div><span className="text-muted-foreground">Docker image: </span><span className="font-mono">{a.image}</span></div>}
            {a.command && <div><span className="text-muted-foreground">Command: </span><span className="font-mono">{a.command}</span></div>}
            {a.env && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground mb-1">Environment variables</div>
                <pre className="max-h-32 overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">{a.env}</pre>
              </div>
            )}
            {a.composeFile && (
              <div className="mt-1">
                <div className="text-xs text-muted-foreground mb-1">docker-compose.yml</div>
                <pre className="max-h-48 overflow-auto rounded border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{a.composeFile}</pre>
              </div>
            )}
          </section>
          {failed && (
            <Alert variant="destructive">
              <AlertTitle>The last deploy failed</AlertTitle>
              <AlertDescription className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" variant="outline" disabled={analyze.isPending} onClick={() => analyze.mutate(failed.id)}>
                  <Sparkles />{analyze.isPending ? 'Starting Claude Code…' : 'Analyze & Fix with Claude Code'}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
              {activeDepId && (
                <Button size="sm" variant="outline" disabled={analyze.isPending} onClick={() => analyze.mutate(activeDepId)}>
                  <Sparkles />{analyze.isPending ? 'Starting Claude Code…' : 'AI Analyze Logs (Claude Code)'}
                </Button>
              )}
            </div>
            {!a.deployments.length && <p className="text-sm text-muted-foreground">None yet.</p>}
            <ItemGroup className="gap-1">
              {a.deployments.map((d) => (
                <Item key={d.id} variant={activeDepId === d.id ? 'muted' : 'outline'} size="sm" asChild>
                  <button type="button" onClick={() => setLogOf(d.id)}>
                    <ItemMedia><StatusLight state={lightOf(d.status)} /></ItemMedia>
                    <ItemContent><ItemTitle>{d.title}</ItemTitle><ItemDescription>{new Date(d.createdAt).toLocaleString()}</ItemDescription></ItemContent>
                    <ItemActions><span className="text-xs capitalize text-muted-foreground">{d.status}</span></ItemActions>
                  </button>
                </Item>
              ))}
            </ItemGroup>
            {activeDepId && (
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
                {(logOf ? logs.data?.logs : activeLogs.data?.logs) || 'Loading…'}
              </pre>
            )}
          </section>
        </>}
      </PageBody>
      {a && (
        <>
          <EditHostedAppDialog open={editing} onOpenChange={setEditing} kind={kind} id={id} app={a} />
          <AddDomainDialog open={addingDomain} onOpenChange={setAddingDomain} kind={kind} id={id} />
          <AskClaudeDialog open={asking} onOpenChange={setAsking}
            initial={`Inspect and manage the hosted ${kind} "${a.name}" (id: ${id}, kind: ${kind}). Read its current configuration with hosting_get and latest logs with hosting_logs, then make the requested edits with hosting_update / hosting_domain_add and redeploy.`} />
        </>
      )}
    </>
  )
}

function EditHostedAppDialog({ open, onOpenChange, kind, id, app }: {
  open: boolean; onOpenChange: (o: boolean) => void; kind: Kind; id: string
  app: {
    name: string; source: string | null; buildType: string | null; dockerfile?: string | null
    repository: string | null; branch: string | null; buildPath?: string | null
    image: string | null; composeFile: string | null; command?: string | null; env: string
  }
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(app.name)
  const [url, setUrl] = useState(app.repository ?? '')
  const [branch, setBranch] = useState(app.branch ?? 'main')
  const [buildPath, setBuildPath] = useState(app.buildPath ?? '/')
  const [buildType, setBuildType] = useState(app.buildType ?? 'nixpacks')
  const [dockerfile, setDockerfile] = useState(app.dockerfile ?? '')
  const [dockerImage, setDockerImage] = useState(app.image ?? '')
  const [composeFile, setComposeFile] = useState(app.composeFile ?? '')
  const [command, setCommand] = useState(app.command ?? '')
  const [env, setEnv] = useState(app.env ?? '')

  useEffect(() => {
    if (open) {
      setName(app.name)
      setUrl(app.repository ?? '')
      setBranch(app.branch ?? 'main')
      setBuildPath(app.buildPath ?? '/')
      setBuildType(app.buildType ?? 'nixpacks')
      setDockerfile(app.dockerfile ?? '')
      setDockerImage(app.image ?? '')
      setComposeFile(app.composeFile ?? '')
      setCommand(app.command ?? '')
      setEnv(app.env ?? '')
    }
  }, [open, app])

  const save = useMutation({
    mutationFn: (redeploy: boolean) => unwrap(api.api.hosting.apps[':kind'][':id'].$patch({
      param: { kind, id },
      json: {
        name: name.trim() || undefined,
        ...(kind === 'compose'
          ? {
              composeFile: composeFile || undefined,
              ...(url.trim() ? { url: url.trim(), branch: branch.trim() || 'main', buildPath: buildPath.trim() || '/' } : {}),
            }
          : dockerImage.trim()
          ? { dockerImage: dockerImage.trim() }
          : url.trim()
          ? {
              url: url.trim(),
              branch: branch.trim() || 'main',
              buildPath: buildPath.trim() || '/',
              buildType: buildType as 'nixpacks',
              dockerfile: dockerfile.trim() || undefined,
            }
          : {}),
        command: command.trim() || null,
        env,
        redeploy,
      },
    })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hosting'] })
      onOpenChange(false)
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={`Edit ${app.name}`}
      description="Updates this app directly in the bundled Dokploy engine.">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(false) }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="eh-name">Name</FieldLabel>
            <Input id="eh-name" className="h-10 font-mono" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {kind === 'compose' ? (
            <Field>
              <FieldLabel htmlFor="eh-compose">docker-compose.yml</FieldLabel>
              <Textarea id="eh-compose" rows={9} className="font-mono text-xs" value={composeFile} onChange={(e) => setComposeFile(e.target.value)} />
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="eh-url">Git repository URL (if Git-based)</FieldLabel>
                <Input id="eh-url" className="h-10 font-mono" placeholder="https://github.com/me/app.git" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              {url.trim() && (
                <div className="grid grid-cols-3 gap-3">
                  <Field>
                    <FieldLabel htmlFor="eh-branch">Branch</FieldLabel>
                    <Input id="eh-branch" className="h-10 font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="eh-path">Build path</FieldLabel>
                    <Input id="eh-path" className="h-10 font-mono" value={buildPath} onChange={(e) => setBuildPath(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="eh-build">Build type</FieldLabel>
                    <NativeSelect id="eh-build" className="[&_select]:h-10" value={buildType} onChange={(e) => setBuildType(e.target.value)}>
                      <option value="nixpacks">Nixpacks</option>
                      <option value="railpack">Railpack</option>
                      <option value="dockerfile">Dockerfile</option>
                      <option value="static">Static site</option>
                      <option value="heroku_buildpacks">Heroku buildpacks</option>
                      <option value="paketo_buildpacks">Paketo buildpacks</option>
                    </NativeSelect>
                  </Field>
                </div>
              )}
              <Field>
                <FieldLabel htmlFor="eh-image">Docker image (if image-based)</FieldLabel>
                <Input id="eh-image" className="h-10 font-mono" placeholder="nginx:alpine" value={dockerImage} onChange={(e) => setDockerImage(e.target.value)} />
              </Field>
            </>
          )}
          <Field>
            <FieldLabel htmlFor="eh-cmd">Custom command (optional)</FieldLabel>
            <Input id="eh-cmd" className="h-10 font-mono" placeholder="npm run start" value={command} onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="eh-env">Environment variables</FieldLabel>
            <Textarea id="eh-env" rows={4} className="font-mono text-xs" placeholder="KEY=value" value={env} onChange={(e) => setEnv(e.target.value)} />
          </Field>
          <ErrorAlert error={save.error} />
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" variant="outline" disabled={save.isPending}>Save changes</Button>
            <Button type="button" disabled={save.isPending} onClick={() => save.mutate(true)}>
              <Rocket />{save.isPending ? 'Saving…' : 'Save & Redeploy'}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

function AddDomainDialog({ open, onOpenChange, kind, id }: { open: boolean; onOpenChange: (o: boolean) => void; kind: Kind; id: string }) {
  const qc = useQueryClient()
  const [host, setHost] = useState('')
  const [port, setPort] = useState('3000')
  const [https, setHttps] = useState(false)
  const [serviceName, setServiceName] = useState('')

  const add = useMutation({
    mutationFn: () => unwrap(api.api.hosting.apps[':kind'][':id'].domains.$post({
      param: { kind, id },
      json: {
        host: host.trim(),
        port: Number(port) || 3000,
        https,
        ...(kind === 'compose' && serviceName.trim() ? { serviceName: serviceName.trim() } : {}),
      },
    })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hosting', 'app', kind, id] })
      onOpenChange(false)
      setHost('')
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Add domain" description="Routes traffic through Dokploy's Traefik proxy.">
      <form onSubmit={(e) => { e.preventDefault(); add.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="dom-host">Hostname</FieldLabel>
            <Input id="dom-host" required className="h-10 font-mono" placeholder="app.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="dom-port">Container port</FieldLabel>
              <Input id="dom-port" inputMode="numeric" className="h-10 font-mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
            </Field>
            {kind === 'compose' && (
              <Field>
                <FieldLabel htmlFor="dom-svc">Compose service name</FieldLabel>
                <Input id="dom-svc" className="h-10 font-mono" placeholder="web" value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
              </Field>
            )}
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>Enable HTTPS (Let's Encrypt)</span>
            <Switch checked={https} onCheckedChange={setHttps} />
          </label>
          <ErrorAlert error={add.error} />
          <Button type="submit" className="h-10" disabled={!host.trim() || add.isPending}>
            <Globe />{add.isPending ? 'Adding…' : 'Add domain'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

function CreateDatabaseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [kind, setKind] = useState<DbKind>('postgres')
  const [name, setName] = useState('')
  const [databaseName, setDatabaseName] = useState('')
  const [databaseUser, setDatabaseUser] = useState('agos')
  const [databasePassword, setDatabasePassword] = useState('')
  const [externalPort, setExternalPort] = useState('')

  const create = useMutation({
    mutationFn: () => unwrap(api.api.hosting.databases.$post({
      json: {
        kind,
        name: name.trim(),
        databaseName: databaseName.trim() || undefined,
        databaseUser: databaseUser.trim() || undefined,
        databasePassword: databasePassword.trim() || undefined,
        externalPort: externalPort.trim() ? Number(externalPort.trim()) : null,
      },
    })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['hosting'] })
      onOpenChange(false)
      setName('')
      void navigate({ to: '/hosting/$kind/$id', params: { kind: r.kind, id: r.id } })
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Create Managed Database"
      description="Provisions and starts a managed database container in the bundled Dokploy engine.">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
        <FieldGroup>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="db-kind">Database Engine</FieldLabel>
              <NativeSelect id="db-kind" className="[&_select]:h-10" value={kind} onChange={(e) => setKind(e.target.value as DbKind)}>
                <option value="postgres">PostgreSQL 16</option>
                <option value="mysql">MySQL 8</option>
                <option value="mariadb">MariaDB 11</option>
                <option value="mongo">MongoDB 7</option>
                <option value="redis">Redis 7</option>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="db-name">Instance Name</FieldLabel>
              <Input id="db-name" required className="h-10 font-mono" placeholder="main-db"
                value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
            </Field>
          </div>
          {kind !== 'redis' && (
            <div className="grid grid-cols-2 gap-3">
              {kind !== 'mongo' && (
                <Field>
                  <FieldLabel htmlFor="db-dbname">Database Name</FieldLabel>
                  <Input id="db-dbname" className="h-10 font-mono" placeholder={name.replace(/-/g, '_') || 'app_db'}
                    value={databaseName} onChange={(e) => setDatabaseName(e.target.value)} />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="db-user">Database User</FieldLabel>
                <Input id="db-user" className="h-10 font-mono" value={databaseUser} onChange={(e) => setDatabaseUser(e.target.value)} />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="db-pass">Password (auto if blank)</FieldLabel>
              <Input id="db-pass" type="password" className="h-10 font-mono" placeholder="Auto-generated strong password"
                value={databasePassword} onChange={(e) => setDatabasePassword(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="db-port">External Port (optional)</FieldLabel>
              <Input id="db-port" inputMode="numeric" className="h-10 font-mono" placeholder="Internal network only"
                value={externalPort} onChange={(e) => setExternalPort(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </div>
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!name.trim() || create.isPending}>
            <Database />{create.isPending ? 'Creating database…' : 'Create & Deploy Database'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

export function HostedAppRoute() {
  const { kind, id } = useParams({ from: '/app/hosting/$kind/$id' })
  const validKinds: Kind[] = ['application', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis']
  const k: Kind = validKinds.includes(kind as Kind) ? (kind as Kind) : 'application'
  return <HostedAppPage key={k + id} kind={k} id={id} />
}
