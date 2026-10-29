import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Activity, Database, ExternalLink, FileCode, FolderUp, Globe, LayoutDashboard, Pencil, Play, Plus, RefreshCw, Rocket, Sparkles, Square, Trash2, Upload, X } from 'lucide-react'
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

type SourceType = 'files' | 'git' | 'docker' | 'compose'
type AppRuntime = 'auto' | 'node' | 'python' | 'static' | 'custom' | 'docker'
type StagedFile = { path: string; content: string; encoding: 'utf8' | 'base64'; size: number }

const EMPTY = {
  name: '',
  type: 'files' as SourceType,
  url: '',
  branch: 'main',
  buildPath: '/',
  image: '',
  compose: '',
  buildType: 'nixpacks',
  runtime: 'auto' as AppRuntime,
  startFile: '',
  command: '',
  installCommand: '',
  sourceDir: '',
  port: '3000',
  env: '',
  domain: '',
}

async function readBrowserFile(file: File): Promise<{ content: string; encoding: 'utf8' | 'base64'; size: number }> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const isText = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|htm|css|scss|md|txt|py|sh|yml|yaml|toml|env| dockerfile|sql|go|rs|rb|php|xml|svg)$/i.test(file.name) || file.type.startsWith('text/')
  if (isText && bytes.byteLength < 2_000_000) {
    return { content: new TextDecoder().decode(bytes), encoding: 'utf8', size: bytes.byteLength }
  }
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!)
  return { content: btoa(binary), encoding: 'base64', size: bytes.byteLength }
}

function pickBestEntryFromPaths(paths: string[]): string {
  const candidates = [
    'server.js', 'index.js', 'app.js', 'main.js',
    'src/server.js', 'src/index.js', 'src/app.js',
    'server.ts', 'index.ts', 'main.ts', 'app.ts',
    'src/index.ts', 'src/server.ts',
    'app.py', 'main.py', 'server.py',
    'index.html', 'public/index.html',
  ]
  for (const c of candidates) {
    if (paths.includes(c)) return c
  }
  return paths.find((p) => /\.(js|mjs|ts|py|html)$/i.test(p)) ?? ''
}

function DeployDialog({ open, onOpenChange, domain }: { open: boolean; onOpenChange: (o: boolean) => void; domain: string | null }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [f, setF] = useState(EMPTY)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [archiveFile, setArchiveFile] = useState<{ name: string; base64: string; size: number } | null>(null)
  const [inlinePath, setInlinePath] = useState('')
  const [inlineContent, setInlineContent] = useState('')
  const [addingInline, setAddingInline] = useState(false)

  const set = (p: Partial<typeof EMPTY>) => setF((x) => ({ ...x, ...p }))

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return
    if (fileList.length === 1 && /\.(zip|tar\.gz|tgz|tar)$/i.test(fileList[0]!.name)) {
      const r = await readBrowserFile(fileList[0]!)
      const b64 = r.encoding === 'base64' ? r.content : btoa(r.content)
      setArchiveFile({ name: fileList[0]!.name, base64: b64, size: r.size })
      if (!f.name) {
        const base = fileList[0]!.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
        if (base) set({ name: base })
      }
      return
    }
    const next: StagedFile[] = [...stagedFiles]
    for (const file of Array.from(fileList)) {
      const relRaw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      // Strip top-level folder prefix if uploading a folder via webkitdirectory
      const parts = relRaw.replace(/\\/g, '/').split('/')
      const rel = parts.length > 1 ? parts.slice(1).join('/') : parts[0]!
      if (rel.includes('node_modules/') || rel.startsWith('.git/')) continue
      const r = await readBrowserFile(file)
      const idx = next.findIndex((x) => x.path === rel)
      const item: StagedFile = { path: rel, content: r.content, encoding: r.encoding, size: r.size }
      if (idx >= 0) next[idx] = item
      else next.push(item)
    }
    setStagedFiles(next)
    if (!f.startFile) {
      const detected = pickBestEntryFromPaths(next.map((x) => x.path))
      if (detected) set({ startFile: detected })
    }
  }

  const addInlineFile = () => {
    const p = inlinePath.trim().replace(/^\/+/, '')
    if (!p) return
    const next = [...stagedFiles.filter((x) => x.path !== p), { path: p, content: inlineContent, encoding: 'utf8' as const, size: inlineContent.length }]
    setStagedFiles(next)
    if (!f.startFile) set({ startFile: p })
    setInlinePath('')
    setInlineContent('')
    setAddingInline(false)
  }

  const create = useMutation({
    mutationFn: () => unwrap(api.api.hosting.apps.$post({ json: {
      name: f.name,
      env: f.env || undefined,
      domain: f.domain || null,
      port: Number(f.port) || undefined,
      buildType: f.type === 'git' ? f.buildType as 'nixpacks' : undefined,
      runtime: (f.type === 'files' || f.type === 'git') ? f.runtime : undefined,
      startFile: f.startFile.trim() || null,
      command: f.command.trim() || null,
      installCommand: f.installCommand.trim() || null,
      source: f.type === 'files'
        ? {
            type: 'files',
            files: stagedFiles.length ? stagedFiles.map((s) => ({ path: s.path, content: s.content, encoding: s.encoding })) : undefined,
            archiveBase64: archiveFile?.base64,
            archiveName: archiveFile?.name,
            sourceDir: f.sourceDir.trim() || undefined,
          }
        : f.type === 'git'
        ? { type: 'git', url: f.url, branch: f.branch || undefined, buildPath: f.buildPath || undefined }
        : f.type === 'docker'
        ? { type: 'docker', image: f.image }
        : { type: 'compose', file: f.compose },
    } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['hosting'] })
      onOpenChange(false)
      setF(EMPTY)
      setStagedFiles([])
      setArchiveFile(null)
      void navigate({ to: '/hosting/$kind/$id', params: { kind: r.kind, id: r.id } })
    },
  })
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate() }
  const slug = f.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const candidateEntries = stagedFiles.filter((s) => /\.(js|mjs|cjs|ts|py|html|sh)$/i.test(s.path)).map((s) => s.path)

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Deploy to Dokploy" description="Upload your own files/folder, connect a Git repository, or run a Docker/Compose stack and choose how it starts.">
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="h-name">Name</FieldLabel>
            <Input id="h-name" required className="h-10 font-mono" placeholder="my-app" value={f.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
          </Field>
          <ToggleGroup type="single" variant="outline" size="sm" value={f.type} onValueChange={(v) => v && set({ type: v as SourceType })} aria-label="Source">
            <ToggleGroupItem value="files"><Upload className="size-3.5 mr-1" />Upload / Files</ToggleGroupItem>
            <ToggleGroupItem value="git">Git repo</ToggleGroupItem>
            <ToggleGroupItem value="docker">Docker image</ToggleGroupItem>
            <ToggleGroupItem value="compose">Compose</ToggleGroupItem>
          </ToggleGroup>

          {f.type === 'files' && (
            <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">Upload files, folder, or .zip archive</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium hover:bg-muted">
                    <Upload className="size-3.5" />Files / .zip
                    <input type="file" multiple className="hidden" onChange={(e) => void handleFilesSelected(e.target.files)} />
                  </label>
                  <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium hover:bg-muted">
                    <FolderUp className="size-3.5" />Folder
                    <input
                      type="file"
                      multiple
                      // @ts-expect-error webkitdirectory is standard in browsers
                      webkitdirectory=""
                      className="hidden"
                      onChange={(e) => void handleFilesSelected(e.target.files)}
                    />
                  </label>
                  <Button type="button" size="xs" variant="outline" onClick={() => setAddingInline((v) => !v)}>
                    <FileCode className="size-3.5" />+ Write File
                  </Button>
                </div>
              </div>

              {addingInline && (
                <div className="flex flex-col gap-2 rounded-lg border bg-background p-2.5">
                  <Input
                    className="h-8 font-mono text-xs"
                    placeholder="File path, e.g. server.js or index.html"
                    value={inlinePath}
                    onChange={(e) => setInlinePath(e.target.value)}
                  />
                  <Textarea
                    rows={5}
                    className="font-mono text-xs"
                    placeholder="Paste or write file contents here..."
                    value={inlineContent}
                    onChange={(e) => setInlineContent(e.target.value)}
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" size="xs" variant="ghost" onClick={() => setAddingInline(false)}>Cancel</Button>
                    <Button type="button" size="xs" onClick={addInlineFile} disabled={!inlinePath.trim()}>Add File</Button>
                  </div>
                </div>
              )}

              {archiveFile && (
                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-1.5 text-xs font-mono">
                  <span>Archive: <strong>{archiveFile.name}</strong> ({Math.ceil(archiveFile.size / 1024)} KB)</span>
                  <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => setArchiveFile(null)}><X className="size-3" /></Button>
                </div>
              )}

              {stagedFiles.length > 0 && (
                <div className="max-h-36 overflow-y-auto divide-y rounded-lg border bg-background text-xs">
                  {stagedFiles.map((sf) => (
                    <div key={sf.path} className="flex items-center justify-between px-2.5 py-1.5">
                      <span className="truncate font-mono">{sf.path} <span className="text-muted-foreground">({sf.size} B)</span></span>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant={f.startFile === sf.path ? 'default' : 'ghost'}
                          onClick={() => set({ startFile: sf.path })}
                        >
                          {f.startFile === sf.path ? 'Start File ✓' : 'Set Start'}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-6"
                          onClick={() => setStagedFiles((list) => list.filter((x) => x.path !== sf.path))}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Field>
                <FieldLabel htmlFor="h-srcdir">Or Server Directory Path (optional)</FieldLabel>
                <Input
                  id="h-srcdir"
                  className="h-9 font-mono text-xs"
                  placeholder="e.g. /srv/devdash/projects/my-app or C:\path\to\app"
                  value={f.sourceDir}
                  onChange={(e) => set({ sourceDir: e.target.value })}
                />
              </Field>
            </div>
          )}

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

          {(f.type === 'files' || f.type === 'git') && (
            <div className="grid gap-3 rounded-xl border bg-card p-3">
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="h-runtime">Runtime</FieldLabel>
                  <NativeSelect id="h-runtime" className="[&_select]:h-9" value={f.runtime} onChange={(e) => set({ runtime: e.target.value as AppRuntime })}>
                    <option value="auto">Auto-detect</option>
                    <option value="node">Node.js / TypeScript</option>
                    <option value="python">Python</option>
                    <option value="static">Static HTTP Server (HTML)</option>
                    <option value="custom">Custom Start Command</option>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="h-startfile">Start File (Entrypoint)</FieldLabel>
                  <Input
                    id="h-startfile"
                    className="h-9 font-mono text-xs"
                    placeholder="e.g. server.js, main.py, index.html"
                    value={f.startFile}
                    onChange={(e) => set({ startFile: e.target.value })}
                  />
                </Field>
              </div>
              {candidateEntries.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[11px]">
                  <span className="text-muted-foreground mr-1">Pick entry file:</span>
                  {candidateEntries.slice(0, 6).map((p) => (
                    <Badge
                      key={p}
                      variant={f.startFile === p ? 'default' : 'secondary'}
                      className="cursor-pointer font-mono text-[10px]"
                      onClick={() => set({ startFile: p })}
                    >
                      {p}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="h-startcmd">Start Command (optional override)</FieldLabel>
                  <Input
                    id="h-startcmd"
                    className="h-9 font-mono text-xs"
                    placeholder="e.g. node src/index.js or npm start"
                    value={f.command}
                    onChange={(e) => set({ command: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="h-installcmd">Install / Build Command (optional)</FieldLabel>
                  <Input
                    id="h-installcmd"
                    className="h-9 font-mono text-xs"
                    placeholder="e.g. npm install && npm run build"
                    value={f.installCommand}
                    onChange={(e) => set({ installCommand: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          )}

          {f.type !== 'compose' && (
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <Field>
                <FieldLabel htmlFor="h-port">Port</FieldLabel>
                <Input id="h-port" inputMode="numeric" className="h-10 font-mono" value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="h-domain">Domain</FieldLabel>
                <Input id="h-domain" className="h-10 font-mono" placeholder={domain ? `${slug || 'name'}.${domain}` : `http://127.0.0.1:${f.port || '3000'}`} value={f.domain} onChange={(e) => set({ domain: e.target.value })} />
              </Field>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="h-env">Environment</FieldLabel>
            <Textarea id="h-env" rows={2} className="font-mono text-xs" placeholder="KEY=value" value={f.env} onChange={(e) => set({ env: e.target.value })} />
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
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Configuration &amp; Startup</span>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}><Pencil className="size-3 mr-1" />Edit configuration</Button>
            </div>
            <div><span className="text-muted-foreground">Source: </span><span className="font-mono">{a.source || kind}</span>{a.runtime && a.runtime !== 'auto' ? <span className="text-muted-foreground"> · Runtime: <strong className="font-mono text-foreground">{a.runtime}</strong></span> : null}{a.port ? <span className="text-muted-foreground"> · Port: <strong className="font-mono text-foreground">{a.port}</strong></span> : null}</div>
            {a.startFile && <div><span className="text-muted-foreground">Start file (Entrypoint): </span><Badge variant="secondary" className="font-mono text-xs">{a.startFile}</Badge></div>}
            {a.command && <div><span className="text-muted-foreground">Start command: </span><span className="font-mono">{a.command}</span></div>}
            {a.installCommand && <div><span className="text-muted-foreground">Install / build command: </span><span className="font-mono">{a.installCommand}</span></div>}
            {a.repository && <div><span className="text-muted-foreground">Repository: </span><span className="font-mono">{a.repository}{a.branch ? ` @ ${a.branch}` : ''}{a.buildPath && a.buildPath !== '/' ? ` (${a.buildPath})` : ''}</span></div>}
            {a.buildType && a.source === 'git' && <div><span className="text-muted-foreground">Build type: </span><span className="font-mono">{a.buildType}{a.dockerfile ? ` (${a.dockerfile})` : ''}</span></div>}
            {a.image && <div><span className="text-muted-foreground">Docker image: </span><span className="font-mono">{a.image}</span></div>}
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
          {kind === 'application' && <HostedAppFilesSection appId={id} startFile={a.startFile ?? null} />}
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
            initial={`Inspect and manage the hosted ${kind} "${a.name}" (id: ${id}, kind: ${kind}). Read its current configuration with hosting_get, workspace files with hosting_files_list, and latest logs with hosting_logs, then make the requested edits with hosting_files_upload / hosting_update / hosting_domain_add and redeploy.`} />
        </>
      )}
    </>
  )
}

function HostedAppFilesSection({ appId, startFile }: { appId: string; startFile: string | null }) {
  const qc = useQueryClient()
  const filesQ = useQuery({
    queryKey: ['hosting', 'app', 'application', appId, 'files'],
    queryFn: () => unwrap(api.api.hosting.apps.application[':id'].files.$get({ param: { id: appId } })),
  })
  const [editingFile, setEditingFile] = useState<{ path: string; content: string; isNew?: boolean } | null>(null)

  const upload = useMutation({
    mutationFn: (payload: {
      files?: { path: string; content: string; encoding?: 'utf8' | 'base64' }[]
      archiveBase64?: string
      archiveName?: string
      startFile?: string | null
      redeploy?: boolean
    }) => unwrap(api.api.hosting.apps.application[':id'].files.$post({ param: { id: appId }, json: payload })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hosting'] })
      setEditingFile(null)
    },
  })

  const openFile = useMutation({
    mutationFn: (path: string) => unwrap(api.api.hosting.apps.application[':id'].files.read.$post({ param: { id: appId }, json: { path } })),
    onSuccess: (r) => setEditingFile({ path: r.path, content: r.content }),
  })

  const delFile = useMutation({
    mutationFn: (path: string) => unwrap(api.api.hosting.apps.application[':id'].files.delete.$post({ param: { id: appId }, json: { path } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hosting', 'app', 'application', appId, 'files'] }),
  })

  const onSelectUpload = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return
    if (fileList.length === 1 && /\.(zip|tar\.gz|tgz|tar)$/i.test(fileList[0]!.name)) {
      const r = await readBrowserFile(fileList[0]!)
      const b64 = r.encoding === 'base64' ? r.content : btoa(r.content)
      upload.mutate({ archiveBase64: b64, archiveName: fileList[0]!.name, redeploy: true })
      return
    }
    const items: { path: string; content: string; encoding: 'utf8' | 'base64' }[] = []
    for (const file of Array.from(fileList)) {
      const relRaw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      const parts = relRaw.replace(/\\/g, '/').split('/')
      const rel = parts.length > 1 ? parts.slice(1).join('/') : parts[0]!
      if (rel.includes('node_modules/') || rel.startsWith('.git/')) continue
      const r = await readBrowserFile(file)
      items.push({ path: rel, content: r.content, encoding: r.encoding })
    }
    if (items.length) upload.mutate({ files: items, redeploy: true })
  }

  const files = filesQ.data?.files ?? []
  const activeStart = startFile ?? filesQ.data?.startFile ?? null

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Workspace Files &amp; Entrypoint ({files.length})</h2>
          {filesQ.data?.workDir && <p className="font-mono text-[11px] text-muted-foreground">{filesQ.data.workDir}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium hover:bg-muted">
            <Upload className="size-3.5" />Upload Files / .zip
            <input type="file" multiple className="hidden" onChange={(e) => void onSelectUpload(e.target.files)} />
          </label>
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium hover:bg-muted">
            <FolderUp className="size-3.5" />Upload Folder
            <input
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is standard in browsers
              webkitdirectory=""
              className="hidden"
              onChange={(e) => void onSelectUpload(e.target.files)}
            />
          </label>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setEditingFile({ path: '', content: '', isNew: true })}>
            <Plus className="size-3.5" />New File
          </Button>
        </div>
      </div>

      <ErrorAlert error={filesQ.error ?? upload.error ?? openFile.error ?? delFile.error} />

      {!files.length ? (
        <p className="rounded border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
          No files in this app's workspace yet. Upload files, a folder, or a .zip archive, or click New File to create your start file.
        </p>
      ) : (
        <div className="max-h-64 overflow-y-auto divide-y rounded-md border bg-background text-xs">
          {files.map((f) => {
            const isStart = activeStart === f.path
            return (
              <div key={f.path} className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-muted/20">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    className="truncate font-mono text-left hover:underline underline-offset-4"
                    onClick={() => openFile.mutate(f.path)}
                  >
                    {f.path}
                  </button>
                  <span className="font-mono text-[10px] text-muted-foreground">({f.size} B)</span>
                  {isStart && <Badge variant="default" className="font-mono text-[10px]">Start File ✓</Badge>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!isStart && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={upload.isPending}
                      onClick={() => upload.mutate({ startFile: f.path, redeploy: true })}
                    >
                      Set as Start File
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={() => openFile.mutate(f.path)}>Edit</Button>
                  <Button size="icon" variant="ghost" className="size-6" onClick={() => delFile.mutate(f.path)} aria-label="Delete file">
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ResponsiveDialog
        open={!!editingFile}
        onOpenChange={(o) => { if (!o) setEditingFile(null) }}
        title={editingFile?.isNew ? 'Create File in Hosted App' : `Edit ${editingFile?.path ?? ''}`}
        description="Saves the file into the hosted app workspace and redeploys."
      >
        {editingFile && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!editingFile.path.trim()) return
              upload.mutate({
                files: [{ path: editingFile.path.trim(), content: editingFile.content, encoding: 'utf8' }],
                redeploy: true,
              })
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="wf-path">File Path</FieldLabel>
                <Input
                  id="wf-path"
                  required
                  disabled={!editingFile.isNew}
                  className="h-9 font-mono text-xs"
                  placeholder="e.g. server.js or src/index.ts"
                  value={editingFile.path}
                  onChange={(e) => setEditingFile({ ...editingFile, path: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="wf-content">Contents</FieldLabel>
                <Textarea
                  id="wf-content"
                  rows={12}
                  className="font-mono text-xs"
                  value={editingFile.content}
                  onChange={(e) => setEditingFile({ ...editingFile, content: e.target.value })}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!editingFile.path.trim() || upload.isPending}
                  onClick={() =>
                    upload.mutate({
                      files: [{ path: editingFile.path.trim(), content: editingFile.content, encoding: 'utf8' }],
                      startFile: editingFile.path.trim(),
                      redeploy: true,
                    })
                  }
                >
                  Save as Start File &amp; Redeploy
                </Button>
                <Button type="submit" disabled={!editingFile.path.trim() || upload.isPending}>
                  <Rocket />{upload.isPending ? 'Saving…' : 'Save & Redeploy'}
                </Button>
              </div>
            </FieldGroup>
          </form>
        )}
      </ResponsiveDialog>
    </section>
  )
}

function EditHostedAppDialog({ open, onOpenChange, kind, id, app }: {
  open: boolean; onOpenChange: (o: boolean) => void; kind: Kind; id: string
  app: {
    name: string; source: string | null; buildType: string | null; dockerfile?: string | null
    repository: string | null; branch: string | null; buildPath?: string | null
    image: string | null; composeFile: string | null; command?: string | null
    startFile?: string | null; installCommand?: string | null; runtime?: string | null; port?: number | null
    env: string
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
  const [runtime, setRuntime] = useState<AppRuntime>((app.runtime as AppRuntime) || 'auto')
  const [startFile, setStartFile] = useState(app.startFile ?? '')
  const [command, setCommand] = useState(app.command ?? '')
  const [installCommand, setInstallCommand] = useState(app.installCommand ?? '')
  const [port, setPort] = useState(String(app.port ?? 3000))
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
      setRuntime((app.runtime as AppRuntime) || 'auto')
      setStartFile(app.startFile ?? '')
      setCommand(app.command ?? '')
      setInstallCommand(app.installCommand ?? '')
      setPort(String(app.port ?? 3000))
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
        runtime: kind === 'application' ? runtime : undefined,
        startFile: kind === 'application' ? (startFile.trim() || null) : undefined,
        installCommand: kind === 'application' ? (installCommand.trim() || null) : undefined,
        port: kind === 'application' ? (Number(port) || 3000) : undefined,
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
      description="Update start file, start command, runtime, port, or source settings in Dokploy.">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(false) }}>
        <FieldGroup>
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field>
              <FieldLabel htmlFor="eh-name">Name</FieldLabel>
              <Input id="eh-name" className="h-10 font-mono" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {kind === 'application' && (
              <Field>
                <FieldLabel htmlFor="eh-port">Port</FieldLabel>
                <Input id="eh-port" inputMode="numeric" className="h-10 font-mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
              </Field>
            )}
          </div>
          {kind === 'compose' ? (
            <Field>
              <FieldLabel htmlFor="eh-compose">docker-compose.yml</FieldLabel>
              <Textarea id="eh-compose" rows={9} className="font-mono text-xs" value={composeFile} onChange={(e) => setComposeFile(e.target.value)} />
            </Field>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="eh-runtime">Runtime</FieldLabel>
                  <NativeSelect id="eh-runtime" className="[&_select]:h-10" value={runtime} onChange={(e) => setRuntime(e.target.value as AppRuntime)}>
                    <option value="auto">Auto-detect</option>
                    <option value="node">Node.js / TypeScript</option>
                    <option value="python">Python</option>
                    <option value="static">Static HTTP Server (HTML)</option>
                    <option value="custom">Custom Start Command</option>
                    <option value="docker">Docker</option>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="eh-startfile">Start File (Entrypoint)</FieldLabel>
                  <Input id="eh-startfile" className="h-10 font-mono text-xs" placeholder="server.js / main.py / index.html" value={startFile} onChange={(e) => setStartFile(e.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="eh-cmd">Start Command (optional override)</FieldLabel>
                  <Input id="eh-cmd" className="h-10 font-mono text-xs" placeholder="node server.js / npm run start" value={command} onChange={(e) => setCommand(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="eh-install">Install / Build Command</FieldLabel>
                  <Input id="eh-install" className="h-10 font-mono text-xs" placeholder="npm install" value={installCommand} onChange={(e) => setInstallCommand(e.target.value)} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="eh-url">Git repository URL (optional)</FieldLabel>
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
                <FieldLabel htmlFor="eh-image">Docker image (optional)</FieldLabel>
                <Input id="eh-image" className="h-10 font-mono" placeholder="nginx:alpine" value={dockerImage} onChange={(e) => setDockerImage(e.target.value)} />
              </Field>
            </>
          )}
          <Field>
            <FieldLabel htmlFor="eh-env">Environment variables</FieldLabel>
            <Textarea id="eh-env" rows={3} className="font-mono text-xs" placeholder="KEY=value" value={env} onChange={(e) => setEnv(e.target.value)} />
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
