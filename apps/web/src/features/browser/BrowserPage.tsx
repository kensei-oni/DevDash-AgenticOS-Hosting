import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Bot, Copy, Globe, Maximize, Power, Sparkles, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { NativeSelect } from '@/components/app/native-select'
import { PageHeader, pageCol } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { api, meQuery, unwrap } from '@/lib/api'
import { inShell } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'

/**
 * The team's shared browser on the server: one Chromium that stays signed in to things (logins and tabs persist),
 * streamed here AND controllable in real time by Claude Code via Chrome DevTools Protocol (CDP :9222).
 */
export function BrowserPage() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const navigate = useNavigate()
  const status = useQuery({
    queryKey: ['browser'],
    queryFn: () => unwrap(api.api.browser.$get()),
    refetchInterval: 3_000,
  })
  const [url, setUrl] = useState<string | null>(null)
  const [navUrl, setNavUrl] = useState('')
  const [inviting, setInviting] = useState(false)
  const [asking, setAsking] = useState(false)

  const open = useMutation({
    mutationFn: () => unwrap(api.api.browser.open.$post()),
    onSuccess: (r) => { setUrl(r.url); void qc.invalidateQueries({ queryKey: ['browser'] }) },
  })
  const stop = useMutation({
    mutationFn: () => unwrap(api.api.browser.stop.$post()),
    onSuccess: () => { setUrl(null); void qc.invalidateQueries({ queryKey: ['browser'] }); toast.success('Browser stopped. Logins are kept for next time.') },
    onError: (e) => toast.error(e.message),
  })
  const go = useMutation({
    mutationFn: (target: string) => unwrap(api.api.browser.navigate.$post({ json: { url: target } })),
    onSuccess: (r) => {
      setNavUrl(r.url)
      void qc.invalidateQueries({ queryKey: ['browser'] })
    },
    onError: (e) => toast.error(e.message),
  })

  // Tell the server someone is watching, so it doesn't stop the browser.
  useEffect(() => {
    if (!url) return
    const beat = () => { if (document.visibilityState === 'visible') void api.api.browser.heartbeat.$post() }
    const i = setInterval(beat, 60_000)
    return () => clearInterval(i)
  }, [url])
  // Already running? Join straight away.
  useEffect(() => { if (status.data?.running && !url && !open.isPending && !open.isError) open.mutate() }, [status.data?.running]) // eslint-disable-line react-hooks/exhaustive-deps

  const lastAi = status.data?.lastAiAction
  const aiActiveRecently = lastAi && Date.now() - lastAi.at < 120_000

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Browser" description="Shared Chromium on the server — watch and drive it live with your team & Claude Code"
        actions={<div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
            <Sparkles /><span className="hidden sm:inline">Ask Claude (Live Control)</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => setInviting(true)}>
            <UserPlus /><span className="hidden sm:inline">Invite to watch</span>
          </Button>
          {url && !inShell() && (
            <Button size="sm" variant="outline" onClick={() => document.getElementById('dd-browser')?.requestFullscreen?.()}>
              <Maximize /><span className="hidden sm:inline">Full screen</span>
            </Button>
          )}
          {url && me.role === 'admin' && (
            <Button size="icon-sm" variant="ghost" aria-label="Stop the browser" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <Power />
            </Button>
          )}
        </div>} />
      {inviting && <Invites onClose={() => setInviting(false)} />}
      <AskBrowserClaudeDialog open={asking} onOpenChange={setAsking} onStarted={(id) => void navigate({ to: '/claude/$id', params: { id } })} />
      <div style={pageCol()} className="page-col flex flex-col gap-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <StatusLight state={status.data?.cdpConnected ? 'live' : status.data?.running ? 'waiting' : 'idle'} />
            <span className="font-medium">
              {status.data?.cdpConnected
                ? 'Real-time AI Browser Control (CDP :9222) connected'
                : status.data?.running
                ? 'Browser stream running'
                : 'Browser idle — Claude Code or any member can start it on demand'}
            </span>
            {status.data?.currentUrl && (
              <Badge variant="secondary" className="font-mono text-[11px] max-w-xs truncate">{status.data.currentUrl}</Badge>
            )}
          </div>
          {status.data?.cdpConnected && (
            <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (navUrl.trim()) go.mutate(navUrl) }}>
              <Input className="h-7 w-56 font-mono text-xs" placeholder="https://example.com" value={navUrl} onChange={(e) => setNavUrl(e.target.value)} />
              <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={go.isPending || !navUrl.trim()}>
                <ArrowRight className="size-3" />Go
              </Button>
            </form>
          )}
        </div>
        {lastAi && (
          <div className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${aiActiveRecently ? 'border-emerald-500/40 bg-emerald-500/10' : 'bg-muted/40'}`}>
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="size-3.5 shrink-0 text-emerald-500" />
              <span className="font-medium">Claude Live Browser Action:</span>
              <Badge variant="outline" className="font-mono text-[11px]">{lastAi.action}</Badge>
              <span className="font-mono truncate text-muted-foreground">{lastAi.detail}</span>
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {new Date(lastAi.at).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
      {url ? (
        <div style={pageCol()} className="page-col canvas flex min-h-0 flex-1 flex-col py-2 md:py-4">
          <iframe id="dd-browser" title="Shared browser" src={url} className="min-h-0 w-full flex-1 rounded-lg border-0 bg-black"
            allow="autoplay; clipboard-read; clipboard-write; fullscreen; microphone" />
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted"><Globe className="size-5" /></span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-lg font-semibold">Team &amp; AI Shared Browser</h2>
            <p className="text-sm text-muted-foreground">
              A Chromium on the server that everyone shares — and that Claude Code can drive in real time via <code className="font-mono">browser_*</code> MCP tools while you watch. Sign in to a site once and it stays signed in for the whole team.
            </p>
          </div>
          <ErrorAlert error={status.error ?? open.error} />
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button className="h-10" disabled={open.isPending || status.isPending} onClick={() => open.mutate()}>
              {open.isPending ? <><Spinner />Starting…</> : status.data?.running ? 'Join stream' : 'Start the browser'}
            </Button>
            <Button className="h-10" variant="outline" onClick={() => setAsking(true)}>
              <Sparkles />Have Claude drive it
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">It stops by itself after 30 minutes nobody is watching. Logins and open tabs are kept.</p>
        </div>
      )}
    </div>
  )
}

function AskBrowserClaudeDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; onStarted: (sessionId: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const ask = useMutation({
    mutationFn: () => unwrap(api.api.browser.ask.$post({ json: { prompt } })),
    onSuccess: (r) => {
      onOpenChange(false)
      setPrompt('')
      onStarted(r.sessionId)
    },
  })
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Real-Time AI Browser Control"
      description="Starts a real Claude Code session that drives the shared browser in real time using browser_navigate, browser_click, browser_type, browser_snapshot, browser_screenshot, and browser_eval.">
      <form onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) ask.mutate() }}>
        <FieldGroup>
          <Textarea autoFocus rows={4} required value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Open https://news.ycombinator.com in the shared browser, inspect the top 5 stories, click the first one, and summarize it..." />
          <ErrorAlert error={ask.error} />
          <Button type="submit" className="h-10" disabled={!prompt.trim() || ask.isPending}>
            <Sparkles />{ask.isPending ? 'Starting Claude Code…' : 'Start Live Browser Session'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

const DURATIONS = [[1, '1 hour'], [8, '8 hours'], [24, '1 day'], [72, '3 days'], [168, '7 days']] as const

/** Links for people without a DevDash account: they open the shared browser, watch-only unless allowed to take control. */
function Invites({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['browser', 'invites'], queryFn: () => unwrap(api.api.browser.invites.$get()) })
  const [label, setLabel] = useState('')
  const [hours, setHours] = useState(24)
  const create = useMutation({
    mutationFn: () => unwrap(api.api.browser.invites.$post({ json: { label, hours, canControl: false } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['browser', 'invites'] })
      setLabel('')
      void navigator.clipboard.writeText(r.invite.url).then(() => toast.success('Invite link copied'), () => {})
    },
  })
  const revoke = useMutation({
    mutationFn: (id: number) => unwrap(api.api.browser.invites[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['browser', 'invites'] }),
  })
  const copy = (u: string) => void navigator.clipboard.writeText(u).then(() => toast.success('Invite link copied'))
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()} title="Invite people to watch"
      description="Anyone with the link sees the shared browser live, without a DevDash account. They can't control it or reach anything else in DevDash.">
      <div className="flex flex-col gap-5 pb-2">
        <form onSubmit={(e) => { e.preventDefault(); if (label.trim()) create.mutate() }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="bi-label">Their name</FieldLabel>
              <Input id="bi-label" autoFocus className="h-10" placeholder="Sara from QA" value={label} onChange={(e) => setLabel(e.target.value)} />
              <FieldDescription>Shown to everyone in the browser, marked as a guest.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="bi-hours">Link works for</FieldLabel>
              <NativeSelect id="bi-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {DURATIONS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
              </NativeSelect>
            </Field>
            <ErrorAlert error={create.error} />
            <Button type="submit" className="h-10" disabled={!label.trim() || create.isPending}><UserPlus />Create and copy link</Button>
          </FieldGroup>
        </form>
        {!!list.data?.invites.length && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Active invites</h3>
            <ul className="overflow-hidden rounded-xl border">
              {list.data.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">Watch only, until {new Date(i.expiresAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </span>
                  <Button size="icon-sm" variant="ghost" aria-label="Copy link" onClick={() => copy(i.url)}><Copy /></Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Turn off</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ResponsiveDialog>
  )
}
