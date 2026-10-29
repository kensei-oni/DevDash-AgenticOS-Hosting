import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'

/**
 * Hosting: agOS's real integration with the bundled Dokploy engine (apps/hosting), which runs beside agOS on the same
 * server on non-colliding ports (UI/API 127.0.0.1:3010, Traefik 8880/8843) so it never collides with Caddy (80/443),
 * DevDash (8787) or the services site (8443).
 *
 * Authentication between agOS and its side-by-side Dokploy service is automatic via the shared DEVDASH_MASTER_KEY
 * (`x-agos-key` header, validated in apps/hosting/packages/server/src/lib/auth.ts) or `x-api-key`.
 * Every operation talks directly to the real Dokploy API (/api/*) — no mock tables or fake data.
 */
export type HostingConfig = {
  /** Bundled Dokploy base URL on this server, default http://127.0.0.1:3010 */
  url: string
  apiKey: string | null
  /** Shared agOS master key (base64) used for zero-setup internal authentication with the bundled Dokploy service */
  masterKey?: string | null
  /** Base domain for hosted apps (a wildcard DNS record points at this server): <app>.<domain>. Null: traefik.me. */
  domain: string | null
  /** Where members open Dokploy's own dashboard in the browser, if exposed (Caddy, :3443). */
  dashboardUrl: string | null
}

export type Kind = 'application' | 'compose' | 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'
export type DatabaseKind = 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'
export type HostedApp = {
  kind: Kind
  id: string
  name: string
  appName: string
  status: string
  project: string
  projectId: string
  environment: string
  url?: string | null
}
export type UploadedFileInput = {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}
export type AppRuntime = 'auto' | 'node' | 'python' | 'static' | 'custom' | 'docker'
export type Source =
  | { type: 'git'; url: string; branch?: string; buildPath?: string }
  | { type: 'docker'; image: string }
  | { type: 'compose'; file: string }
  | {
      type: 'files'
      files?: UploadedFileInput[]
      archiveBase64?: string
      archiveName?: string
      sourceDir?: string
    }
export type BuildType = 'nixpacks' | 'dockerfile' | 'railpack' | 'heroku_buildpacks' | 'paketo_buildpacks' | 'static'
export type CreateInput = {
  name: string
  project?: string
  source: Source
  buildType?: BuildType
  dockerfile?: string
  startFile?: string | null
  installCommand?: string | null
  command?: string | null
  runtime?: AppRuntime
  port?: number
  env?: string
  domain?: string | null
  deploy?: boolean
}
export type UpdateInput = {
  name?: string
  url?: string
  branch?: string
  buildPath?: string
  buildType?: BuildType
  dockerfile?: string
  dockerImage?: string
  composeFile?: string
  env?: string
  command?: string | null
  startFile?: string | null
  installCommand?: string | null
  runtime?: AppRuntime
  port?: number
  memoryLimit?: string | null
  cpuLimit?: string | null
  redeploy?: boolean
}
export type UploadFilesInput = {
  files?: UploadedFileInput[]
  archiveBase64?: string
  archiveName?: string
  sourceDir?: string
  clearExisting?: boolean
  startFile?: string | null
  installCommand?: string | null
  command?: string | null
  runtime?: AppRuntime
  port?: number
  redeploy?: boolean
}
export type DomainInput = {
  host: string
  port?: number
  https?: boolean
  path?: string
  serviceName?: string | null
}
export type CreateDatabaseInput = {
  kind: DatabaseKind
  name: string
  project?: string
  databaseName?: string
  databaseUser?: string
  databasePassword?: string
  databaseRootPassword?: string
  dockerImage?: string
  externalPort?: number | null
  deploy?: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const ACTIONS = ['deploy', 'redeploy', 'stop', 'start'] as const
export type Action = (typeof ACTIONS)[number] | 'delete'

export function hostingService({ config, agents, db }: { config: HostingConfig; agents: AgentsService; db: Db }) {
  const qUser = db.prepare('select id, username, name, email, role from users where username = ? and disabled_at is null')
  const url = (config.url || 'http://127.0.0.1:3010').replace(/\/$/, '')
  const domain = config.domain?.replace(/^\*?\./, '') || null
  const dashboardUrl = config.dashboardUrl || `${url}`
  const agosKey = config.masterKey?.trim() || process.env.DEVDASH_MASTER_KEY?.trim() || null

  async function call<T = any>(proc: string, input?: Record<string, unknown>, method: 'GET' | 'POST' = methodOf(proc)): Promise<T> {
    let target = `${url}/api/${proc}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (agosKey) headers['x-agos-key'] = agosKey
    if (config.apiKey) headers['x-api-key'] = config.apiKey
    else if (agosKey) headers['x-api-key'] = agosKey

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) }
    if (method === 'GET' && input) {
      const params = Object.entries(input)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]): [string, string] => [k, String(v)])
      if (params.length) target += '?' + new URLSearchParams(params)
    }
    if (method === 'POST') {
      init.body = JSON.stringify(input ?? {})
      headers['content-type'] = 'application/json'
    }
    let res: Response
    try {
      res = await fetch(target, init)
    } catch {
      throw new AppError(409, 'hosting_unreachable', `Bundled Dokploy engine at ${url} is not reachable. Ensure the dokploy service (apps/hosting on port 3010) is running beside agOS.`)
    }
    const text = await res.text()
    const body = text ? safeJson(text) : null
    if (!res.ok) {
      const msg = (body && (body.message || body.error?.message || body.error?.json?.message)) || `Dokploy engine answered ${res.status}.`
      throw new AppError(res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 403 : 400, 'hosting_error', String(msg))
    }
    return body as T
  }

  const methodOf = (proc: string): 'GET' | 'POST' =>
    /\.(all|one|by[A-Z]\w*|readLogs|readAppMonitoring|allByCompose|search|getEnabledProviders|listFiles)$/.test(proc) ? 'GET' : 'POST'

  async function list(): Promise<HostedApp[]> {
    const projects = (await call<any[]>('project.all')) ?? []
    const out: HostedApp[] = []
    for (const p of projects) {
      for (const e of p.environments ?? []) {
        for (const a of e.applications ?? []) {
          const dom = a.domains?.[0]
          out.push({
            kind: 'application',
            id: a.applicationId,
            name: a.name,
            appName: a.appName ?? a.name,
            status: a.applicationStatus ?? 'idle',
            project: p.name,
            projectId: p.projectId,
            environment: e.name,
            url: dom?.host ? `${dom.https ? 'https' : 'http'}://${dom.host}` : null,
          })
        }
        for (const c of e.compose ?? []) {
          const dom = c.domains?.[0]
          out.push({
            kind: 'compose',
            id: c.composeId,
            name: c.name,
            appName: c.appName ?? c.name,
            status: c.composeStatus ?? 'idle',
            project: p.name,
            projectId: p.projectId,
            environment: e.name,
            url: dom?.host ? `${dom.https ? 'https' : 'http'}://${dom.host}` : null,
          })
        }
        for (const dbKind of ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'] as const) {
          for (const d of e[dbKind] ?? []) {
            const idKey = `${dbKind}Id`
            out.push({
              kind: dbKind,
              id: d[idKey],
              name: d.name,
              appName: d.appName ?? d.name,
              status: d.applicationStatus ?? 'idle',
              project: p.name,
              projectId: p.projectId,
              environment: e.name,
              url: d.externalPort ? `${dbKind}://:${d.externalPort}` : null,
            })
          }
        }
      }
    }
    return out
  }

  async function environmentFor(projectName: string): Promise<string> {
    const projects = (await call<any[]>('project.all')) ?? []
    const found = projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase())
    if (found) {
      const env = (found.environments ?? []).find((e: any) => e.name === 'production') ?? found.environments?.[0]
      if (env) return env.environmentId
    }
    const created = await call<{ environment: { environmentId: string } }>('project.create', {
      name: projectName,
      description: 'Created from agOS Hosting',
    })
    return created.environment.environmentId
  }

  async function get(kind: Kind, id: string) {
    if (kind !== 'application' && kind !== 'compose') {
      const idKey = `${kind}Id`
      const one = await call(`${kind}.one`, { [idKey]: id })
      const deployments = (await call<any[]>('deployment.allByType', { id, type: kind }).catch(() => [])) ?? []
      return {
        kind,
        id,
        name: one.name as string,
        appName: one.appName as string,
        status: (one.applicationStatus as string) ?? 'idle',
        source: kind,
        buildType: null,
        dockerfile: null,
        repository: null,
        branch: null,
        buildPath: '/',
        image: (one.dockerImage as string | null) ?? null,
        composeFile: null,
        command: (one.command as string | null) ?? null,
        startFile: null as string | null,
        installCommand: null as string | null,
        runtime: 'docker' as string,
        port: (one.externalPort as number | null) ?? null,
        env: (one.env as string | null) ?? '',
        domains: one.externalPort
          ? [{ id: `port-${one.externalPort}`, host: `${kind}:${one.externalPort}`, https: false, port: one.externalPort as number, path: '/', serviceName: null, url: `${kind}://127.0.0.1:${one.externalPort}` }]
          : [],
        deployments: deployments.slice(0, 20).map((d) => ({
          id: d.deploymentId as string,
          title: d.title as string,
          status: d.status as string,
          createdAt: d.createdAt as string,
          error: d.errorMessage ?? null,
        })),
      }
    }
    const one = kind === 'application'
      ? await call('application.one', { applicationId: id })
      : await call('compose.one', { composeId: id })
    const deployments = (kind === 'application'
      ? await call<any[]>('deployment.all', { applicationId: id })
      : await call<any[]>('deployment.allByCompose', { composeId: id }).catch(() => [])) ?? []
    return {
      kind,
      id,
      name: one.name as string,
      appName: one.appName as string,
      status: (kind === 'application' ? one.applicationStatus : one.composeStatus) ?? 'idle',
      source: one.sourceType ?? (kind === 'compose' ? 'raw' : null),
      buildType: one.buildType ?? null,
      dockerfile: one.dockerfile ?? null,
      repository: one.customGitUrl ?? one.repository ?? null,
      branch: one.customGitBranch ?? one.branch ?? null,
      buildPath: one.customGitBuildPath ?? one.buildPath ?? '/',
      image: one.dockerImage ?? null,
      composeFile: (one.composeFile as string | null) ?? null,
      command: (one.command as string | null) ?? null,
      startFile: (one.startFile as string | null) ?? null,
      installCommand: (one.installCommand as string | null) ?? null,
      runtime: (one.runtime as string | null) ?? 'auto',
      port: (one.port as number | null) ?? (one.domains?.[0]?.port as number | null) ?? 3000,
      env: (one.env as string | null) ?? '',
      domains: ((one.domains ?? []) as any[]).map((d) => ({
        id: d.domainId as string,
        host: d.host as string,
        https: !!d.https,
        port: d.port ?? null,
        path: d.path ?? '/',
        serviceName: d.serviceName ?? null,
        url: `${d.https ? 'https' : 'http'}://${d.host}${d.path && d.path !== '/' ? d.path : ''}`,
      })),
      deployments: deployments.slice(0, 20).map((d) => ({
        id: d.deploymentId as string,
        title: d.title as string,
        status: d.status as string,
        createdAt: d.createdAt as string,
        error: d.errorMessage ?? null,
      })),
    }
  }

  async function logs(deploymentId: string): Promise<string> {
    const r = await call<any>('deployment.readLogs', { deploymentId, tail: 400 })
    return typeof r === 'string' ? r : String(r?.logs ?? r?.log ?? (r ? JSON.stringify(r) : ''))
  }

  async function create(user: User, input: CreateInput) {
    const name = input.name.trim().toLowerCase()
    if (!NAME_RE.test(name)) throw new AppError(400, 'bad_name', 'Use lowercase letters, digits and dashes (up to 41).')
    const environmentId = await environmentFor(input.project?.trim() || 'agOS')
    const description = `Created by ${user.name} from agOS`
    let kind: Kind, id: string, appName: string

    if (input.source.type === 'compose') {
      const c = await call('compose.create', {
        name,
        environmentId,
        description,
        composeType: 'docker-compose',
        composeFile: input.source.file,
      })
      kind = 'compose'
      id = c.composeId
      appName = c.appName
      if (input.env) await call('compose.update', { composeId: id, env: input.env })
    } else {
      const a = await call('application.create', { name, environmentId, description })
      kind = 'application'
      id = a.applicationId
      appName = a.appName
      if (input.source.type === 'files') {
        await call('application.uploadFiles', {
          applicationId: id,
          files: input.source.files,
          archiveBase64: input.source.archiveBase64,
          archiveName: input.source.archiveName,
          sourceDir: input.source.sourceDir,
          startFile: input.startFile ?? undefined,
          installCommand: input.installCommand ?? undefined,
          command: input.command ?? undefined,
          runtime: input.runtime ?? 'auto',
          port: input.port ?? 3000,
        }, 'POST')
      } else if (input.source.type === 'git') {
        await call('application.saveGitProvider', {
          applicationId: id,
          customGitUrl: input.source.url,
          customGitBranch: input.source.branch || 'main',
          customGitBuildPath: input.source.buildPath || '/',
          watchPaths: null,
          customGitSSHKeyId: null,
        })
        await call('application.saveBuildType', {
          applicationId: id,
          buildType: input.buildType ?? 'nixpacks',
          dockerfile: input.dockerfile ?? (input.buildType === 'dockerfile' ? 'Dockerfile' : null),
          dockerContextPath: null,
          dockerBuildStage: null,
          herokuVersion: null,
          railpackVersion: null,
          publishDirectory: null,
          isStaticSpa: null,
        })
        if (input.startFile || input.installCommand || input.command || input.runtime || input.port) {
          await call('application.update', {
            applicationId: id,
            startFile: input.startFile ?? undefined,
            installCommand: input.installCommand ?? undefined,
            command: input.command ?? undefined,
            runtime: input.runtime ?? undefined,
            port: input.port ?? undefined,
          })
        }
      } else {
        await call('application.saveDockerProvider', {
          applicationId: id,
          dockerImage: input.source.image,
          username: null,
          password: null,
          registryUrl: null,
        })
      }
      if (input.env) {
        await call('application.saveEnvironment', {
          applicationId: id,
          env: input.env,
          buildArgs: null,
          buildSecrets: null,
          createEnvFile: true,
        })
      }
    }

    const appPort = input.port ?? 3000
    let host = input.domain?.trim() || (domain ? `${name}.${domain}` : null)
    if (!host && input.source.type !== 'compose') {
      host = (await call<string>('domain.generateDomain', { appName }).catch(() => null)) || `127.0.0.1:${appPort}`
    }
    if (host && input.source.type !== 'compose') {
      await call('domain.create', {
        host,
        path: '/',
        port: appPort,
        https: Boolean(domain),
        applicationId: id,
        certificateType: domain ? 'letsencrypt' : 'none',
        stripPath: false,
      })
    }
    if (input.deploy !== false) await action(kind, id, 'deploy', user)
    return { kind, id, name, url: host ? `${domain ? 'https' : 'http'}://${host}` : `http://127.0.0.1:${appPort}` }
  }

  /** Edit an existing hosted application or compose stack (source, branch, buildType, image, composeFile, env, command, startFile, installCommand, runtime, port, name) and optionally redeploy. */
  async function update(user: User, kind: Kind, id: string, patch: UpdateInput) {
    if (kind === 'compose') {
      const payload: Record<string, unknown> = { composeId: id }
      if (patch.name !== undefined) payload.name = patch.name.trim()
      if (patch.composeFile !== undefined) {
        payload.composeFile = patch.composeFile
        payload.sourceType = 'raw'
      }
      if (patch.url !== undefined) {
        payload.customGitUrl = patch.url
        payload.sourceType = 'git'
        if (patch.branch !== undefined) payload.customGitBranch = patch.branch
        if (patch.buildPath !== undefined) payload.composePath = patch.buildPath
      }
      if (patch.env !== undefined) payload.env = patch.env
      if (patch.command !== undefined) payload.command = patch.command
      await call('compose.update', payload)
    } else {
      if (
        patch.name !== undefined ||
        patch.command !== undefined ||
        patch.startFile !== undefined ||
        patch.installCommand !== undefined ||
        patch.runtime !== undefined ||
        patch.port !== undefined ||
        patch.memoryLimit !== undefined ||
        patch.cpuLimit !== undefined
      ) {
        const updatePayload: Record<string, unknown> = { applicationId: id }
        if (patch.name !== undefined) updatePayload.name = patch.name.trim()
        if (patch.command !== undefined) updatePayload.command = patch.command
        if (patch.startFile !== undefined) updatePayload.startFile = patch.startFile
        if (patch.installCommand !== undefined) updatePayload.installCommand = patch.installCommand
        if (patch.runtime !== undefined) updatePayload.runtime = patch.runtime
        if (patch.port !== undefined) updatePayload.port = patch.port
        if (patch.memoryLimit !== undefined) updatePayload.memoryLimit = patch.memoryLimit
        if (patch.cpuLimit !== undefined) updatePayload.cpuLimit = patch.cpuLimit
        await call('application.update', updatePayload)
      }
      if (patch.url !== undefined || patch.branch !== undefined || patch.buildPath !== undefined) {
        const current = await call('application.one', { applicationId: id })
        await call('application.saveGitProvider', {
          applicationId: id,
          customGitUrl: patch.url ?? current.customGitUrl ?? current.repository ?? '',
          customGitBranch: patch.branch ?? current.customGitBranch ?? current.branch ?? 'main',
          customGitBuildPath: patch.buildPath ?? current.customGitBuildPath ?? current.buildPath ?? '/',
          watchPaths: current.watchPaths ?? null,
          customGitSSHKeyId: current.customGitSSHKeyId ?? null,
        })
      }
      if (patch.buildType !== undefined || patch.dockerfile !== undefined) {
        const current = await call('application.one', { applicationId: id })
        const bt = patch.buildType ?? current.buildType ?? 'nixpacks'
        await call('application.saveBuildType', {
          applicationId: id,
          buildType: bt,
          dockerfile: patch.dockerfile ?? current.dockerfile ?? (bt === 'dockerfile' ? 'Dockerfile' : null),
          dockerContextPath: current.dockerContextPath ?? null,
          dockerBuildStage: current.dockerBuildStage ?? null,
          herokuVersion: current.herokuVersion ?? null,
          railpackVersion: current.railpackVersion ?? null,
          publishDirectory: current.publishDirectory ?? null,
          isStaticSpa: current.isStaticSpa ?? null,
        })
      }
      if (patch.dockerImage !== undefined) {
        await call('application.saveDockerProvider', {
          applicationId: id,
          dockerImage: patch.dockerImage,
          username: null,
          password: null,
          registryUrl: null,
        })
      }
      if (patch.env !== undefined) {
        await call('application.saveEnvironment', {
          applicationId: id,
          env: patch.env,
          buildArgs: null,
          buildSecrets: null,
          createEnvFile: true,
        })
      }
    }
    if (patch.redeploy) await action(kind, id, 'redeploy', user)
    return get(kind, id)
  }

  /** Add a public domain route to a hosted application or compose stack in Dokploy. */
  async function addDomain(kind: Kind, id: string, input: DomainInput) {
    const host = input.host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!host) throw new AppError(400, 'bad_domain', 'Enter a domain hostname.')
    const https = input.https ?? Boolean(domain)
    const created = await call('domain.create', {
      host,
      path: input.path || '/',
      port: input.port ?? 3000,
      https,
      certificateType: https ? 'letsencrypt' : 'none',
      stripPath: false,
      ...(kind === 'application'
        ? { applicationId: id, domainType: 'application' }
        : { composeId: id, domainType: 'compose', serviceName: input.serviceName || null }),
    })
    return {
      id: (created?.domainId ?? created?.id ?? host) as string,
      host,
      https,
      port: input.port ?? 3000,
      url: `${https ? 'https' : 'http'}://${host}`,
    }
  }

  /** Remove a domain route from Dokploy. */
  async function removeDomain(domainId: string) {
    await call('domain.delete', { domainId })
    return { ok: true }
  }

  /** Create and deploy a managed database (Postgres, MySQL, MariaDB, MongoDB, or Redis) in Dokploy. */
  async function createDatabase(user: User, input: CreateDatabaseInput) {
    const name = input.name.trim().toLowerCase()
    if (!NAME_RE.test(name)) throw new AppError(400, 'bad_name', 'Use lowercase letters, digits and dashes (up to 41).')
    const environmentId = await environmentFor(input.project?.trim() || 'agOS')
    const pass = input.databasePassword?.trim() || `agos_${Math.random().toString(36).slice(2, 12)}`
    const rootPass = input.databaseRootPassword?.trim() || pass
    const dbName = input.databaseName?.trim() || name.replace(/-/g, '_')
    const dbUser = input.databaseUser?.trim() || 'agos'
    const defaultImages: Record<DatabaseKind, string> = {
      postgres: 'postgres:16',
      mysql: 'mysql:8',
      mariadb: 'mariadb:11',
      mongo: 'mongo:7',
      redis: 'redis:7',
    }
    const payload: Record<string, unknown> = {
      name,
      appName: `agos-${input.kind}-${name}`,
      environmentId,
      description: `Created by ${user.name} from agOS`,
      databasePassword: pass,
      dockerImage: input.dockerImage?.trim() || defaultImages[input.kind],
    }
    if (input.kind === 'postgres') {
      payload.databaseName = dbName
      payload.databaseUser = dbUser
    } else if (input.kind === 'mysql' || input.kind === 'mariadb') {
      payload.databaseName = dbName
      payload.databaseUser = dbUser
      payload.databaseRootPassword = rootPass
    } else if (input.kind === 'mongo') {
      payload.databaseUser = dbUser
    }
    const created = await call(`${input.kind}.create`, payload)
    const idKey = `${input.kind}Id`
    const id = (created?.[idKey] ?? created?.id) as string
    if (input.externalPort && id) {
      await call(`${input.kind}.saveExternalPort`, { [idKey]: id, externalPort: input.externalPort }).catch(() => {})
    }
    if (input.deploy !== false && id) {
      await call(`${input.kind}.deploy`, { [idKey]: id }).catch(() => {})
    }
    return { kind: input.kind, id, name, externalPort: input.externalPort ?? null }
  }

  /** Direct pass-through to any Dokploy API procedure (/api/<proc>) for full Dokploy feature parity. */
  async function dokployCall(proc: string, input?: Record<string, unknown>, method?: 'GET' | 'POST') {
    const clean = proc.trim().replace(/^\/?(api\/)?/, '')
    if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(clean)) {
      throw new AppError(400, 'bad_procedure', 'Procedure must be <router>.<procedure>, e.g. docker.getContainers or certificates.all.')
    }
    return call(clean, input, method ?? methodOf(clean))
  }

  async function action(kind: Kind, id: string, what: Action, user: User) {
    if (what === 'delete' && user.role !== 'admin') throw new AppError(403, 'forbidden', 'Only admins can delete hosted apps.')
    const idKey = `${kind}Id`
    const key = { [idKey]: id }
    const body = (what === 'deploy' || what === 'redeploy') && (kind === 'application' || kind === 'compose')
      ? { ...key, title: `${what} by ${user.name} (agOS)` }
      : key
    if (what === 'delete' && kind === 'compose') await call('compose.delete', { ...key, deleteVolumes: false })
    else if (what === 'delete' && kind !== 'application') await call(`${kind}.remove`, key)
    else if (what === 'redeploy' && kind !== 'application' && kind !== 'compose') await call(`${kind}.rebuild`, key)
    else await call(`${kind}.${what}`, body)
    return { ok: true }
  }

  /** Read live container CPU/memory telemetry for a hosted Dokploy app when available. */
  async function appMonitoring(appName: string) {
    return call('application.readAppMonitoring', { appName }).catch(() => null)
  }

  /** List files and start configuration in a hosted application's workspace. */
  async function listFiles(id: string) {
    return call<{
      workDir: string
      startFile: string | null
      command: string | null
      installCommand: string | null
      runtime: string
      port: number
      files: { path: string; size: number; updatedAt: string }[]
    }>('application.listFiles', { applicationId: id }, 'GET')
  }

  /** Upload or update files, archive, or server directory for a hosted application and optionally redeploy. */
  async function uploadFiles(user: User, id: string, input: UploadFilesInput) {
    const res = await call<{
      ok: boolean
      workDir: string
      startFile: string | null
      files: { path: string; size: number; updatedAt: string }[]
    }>('application.uploadFiles', {
      applicationId: id,
      files: input.files,
      archiveBase64: input.archiveBase64,
      archiveName: input.archiveName,
      sourceDir: input.sourceDir,
      clearExisting: input.clearExisting,
      startFile: input.startFile,
      installCommand: input.installCommand,
      command: input.command,
      runtime: input.runtime,
      port: input.port,
    }, 'POST')
    if (input.redeploy !== false) {
      await action('application', id, 'redeploy', user)
    }
    return res
  }

  /** Read a single file from a hosted application's workspace. */
  async function readFile(id: string, path: string) {
    return call<{ path: string; content: string; size: number }>('application.readFile', { applicationId: id, path }, 'POST')
  }

  /** Delete a file from a hosted application's workspace. */
  async function deleteFile(id: string, path: string) {
    return call<{ ok: boolean; files: { path: string; size: number; updatedAt: string }[] }>('application.deleteFile', { applicationId: id, path }, 'POST')
  }

  async function status() {
    try {
      await call('project.all')
      return {
        configured: true,
        reachable: true,
        url,
        dashboardUrl,
        domain,
        error: null as string | null,
      }
    } catch (e) {
      return {
        configured: true,
        reachable: false,
        url,
        dashboardUrl,
        domain,
        error: (e as Error).message,
      }
    }
  }

  /** Claude's hosting tools (packages/claude-plugin/mcp/devdash.mjs), acting as the member whose session calls them. */
  function registerMcp() {
    const who = (username: string) => {
      const u = qUser.get(username) as User | undefined
      if (!u) throw new AppError(403, 'forbidden', 'Unknown member.')
      return u
    }
    const args = (params: unknown) => (((params ?? {}) as { args?: Record<string, unknown> }).args ?? {})
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const kindOf = (v: unknown): Kind =>
      v === 'compose' || v === 'postgres' || v === 'mysql' || v === 'mariadb' || v === 'mongo' || v === 'redis' ? v : 'application'
    const need = (v: unknown, what: string) => str(v) ?? (() => { throw new AppError(400, 'bad_args', `Pass ${what}.`) })()

    agents.onRpc('mcp.hosting_status', () => status())
    agents.onRpc('mcp.hosting_list', () => list())
    agents.onRpc('mcp.hosting_get', (_u, p) => {
      const a = args(p)
      return get(kindOf(a.kind), need(a.id, 'id'))
    })
    agents.onRpc('mcp.hosting_logs', (_u, p) => logs(need(args(p).deployment_id, 'deployment_id')))
    agents.onRpc('mcp.hosting_create', (u, p) => {
      const a = args(p)
      const hasFiles = Array.isArray(a.files) || Boolean(str(a.source_dir)) || Boolean(str(a.archive_base64)) || a.source_type === 'files'
      const source: Source = hasFiles
        ? {
            type: 'files',
            files: Array.isArray(a.files) ? (a.files as UploadedFileInput[]) : undefined,
            sourceDir: str(a.source_dir),
            archiveBase64: str(a.archive_base64),
            archiveName: str(a.archive_name),
          }
        : str(a.compose_file)
        ? { type: 'compose', file: str(a.compose_file)! }
        : str(a.docker_image)
        ? { type: 'docker', image: str(a.docker_image)! }
        : { type: 'git', url: need(a.git_url, 'git_url, docker_image, compose_file, files, or source_dir'), branch: str(a.branch), buildPath: str(a.build_path) }
      return create(who(u), {
        name: need(a.name, 'name'),
        project: str(a.project),
        source,
        buildType: str(a.build_type) as BuildType | undefined,
        dockerfile: str(a.dockerfile),
        startFile: str(a.start_file) ?? null,
        installCommand: str(a.install_command) ?? null,
        command: str(a.start_command) ?? str(a.command) ?? null,
        runtime: (str(a.runtime) as AppRuntime | undefined) ?? undefined,
        port: typeof a.port === 'number' ? a.port : undefined,
        env: typeof a.env === 'string' ? a.env : undefined,
        domain: str(a.domain) ?? null,
        deploy: a.deploy !== false,
      })
    })
    agents.onRpc('mcp.hosting_update', (u, p) => {
      const a = args(p)
      return update(who(u), kindOf(a.kind), need(a.id, 'id'), {
        name: str(a.name),
        url: str(a.git_url),
        branch: str(a.branch),
        buildPath: str(a.build_path),
        buildType: str(a.build_type) as BuildType | undefined,
        dockerfile: str(a.dockerfile),
        dockerImage: str(a.docker_image),
        composeFile: str(a.compose_file),
        env: typeof a.env === 'string' ? a.env : undefined,
        command: typeof a.start_command === 'string' ? a.start_command : typeof a.command === 'string' ? a.command : undefined,
        startFile: typeof a.start_file === 'string' ? a.start_file : undefined,
        installCommand: typeof a.install_command === 'string' ? a.install_command : undefined,
        runtime: str(a.runtime) as AppRuntime | undefined,
        port: typeof a.port === 'number' ? a.port : undefined,
        memoryLimit: str(a.memory_limit),
        cpuLimit: str(a.cpu_limit),
        redeploy: a.redeploy === true,
      })
    })
    agents.onRpc('mcp.hosting_files_list', (_u, p) => listFiles(need(args(p).id, 'id')))
    agents.onRpc('mcp.hosting_files_upload', (u, p) => {
      const a = args(p)
      return uploadFiles(who(u), need(a.id, 'id'), {
        files: Array.isArray(a.files) ? (a.files as UploadedFileInput[]) : undefined,
        sourceDir: str(a.source_dir),
        archiveBase64: str(a.archive_base64),
        archiveName: str(a.archive_name),
        clearExisting: a.clear_existing === true,
        startFile: typeof a.start_file === 'string' ? a.start_file : undefined,
        installCommand: typeof a.install_command === 'string' ? a.install_command : undefined,
        command: typeof a.start_command === 'string' ? a.start_command : typeof a.command === 'string' ? a.command : undefined,
        runtime: str(a.runtime) as AppRuntime | undefined,
        port: typeof a.port === 'number' ? a.port : undefined,
        redeploy: a.redeploy !== false,
      })
    })
    agents.onRpc('mcp.hosting_files_read', (_u, p) => {
      const a = args(p)
      return readFile(need(a.id, 'id'), need(a.path, 'path'))
    })
    agents.onRpc('mcp.hosting_files_delete', (_u, p) => {
      const a = args(p)
      return deleteFile(need(a.id, 'id'), need(a.path, 'path'))
    })
    agents.onRpc('mcp.hosting_domain_add', (_u, p) => {
      const a = args(p)
      return addDomain(kindOf(a.kind), need(a.id, 'id'), {
        host: need(a.host, 'host'),
        port: typeof a.port === 'number' ? a.port : undefined,
        https: typeof a.https === 'boolean' ? a.https : undefined,
        path: str(a.path),
        serviceName: str(a.service_name),
      })
    })
    agents.onRpc('mcp.hosting_domain_remove', (_u, p) => removeDomain(need(args(p).domain_id, 'domain_id')))
    agents.onRpc('mcp.hosting_db_create', (u, p) => {
      const a = args(p)
      const dbKind = need(a.db_type, 'db_type') as DatabaseKind
      if (!['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(dbKind)) {
        throw new AppError(400, 'bad_args', 'db_type must be postgres, mysql, mariadb, mongo or redis.')
      }
      return createDatabase(who(u), {
        kind: dbKind,
        name: need(a.name, 'name'),
        project: str(a.project),
        databaseName: str(a.database_name),
        databaseUser: str(a.database_user),
        databasePassword: str(a.database_password),
        dockerImage: str(a.docker_image),
        externalPort: typeof a.external_port === 'number' ? a.external_port : undefined,
        deploy: a.deploy !== false,
      })
    })
    agents.onRpc('mcp.hosting_dokploy_api', (_u, p) => {
      const a = args(p)
      const proc = need(a.procedure, 'procedure')
      const input = (a.input && typeof a.input === 'object' ? a.input : undefined) as Record<string, unknown> | undefined
      const method = a.method === 'GET' || a.method === 'POST' ? a.method : undefined
      return dokployCall(proc, input, method)
    })
    agents.onRpc('mcp.hosting_action', (u, p) => {
      const a = args(p)
      const what = need(a.action, 'action') as Action
      if (![...ACTIONS, 'delete'].includes(what)) throw new AppError(400, 'bad_args', 'action must be deploy, redeploy, stop, start or delete.')
      return action(kindOf(a.kind), need(a.id, 'id'), what, who(u))
    })
  }

  return {
    status,
    list,
    get,
    logs,
    create,
    createDatabase,
    update,
    addDomain,
    removeDomain,
    action,
    dokployCall,
    appMonitoring,
    listFiles,
    uploadFiles,
    readFile,
    deleteFile,
    registerMcp,
  }
}

function safeJson(t: string) {
  try { return JSON.parse(t) } catch { return t }
}

export type HostingService = ReturnType<typeof hostingService>
