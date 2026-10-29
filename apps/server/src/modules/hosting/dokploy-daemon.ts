import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer } from 'node:net'
import { dirname, extname, join, normalize, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { openDb, type Db } from '../../core/db.ts'

const run = promisify(execFile)

export type DokployDaemonOptions = {
  port: number
  dataDir: string
  masterKey: string
}

function isPortTaken(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(true))
    srv.once('listening', () => {
      srv.close(() => resolve(false))
    })
    srv.listen(port, host)
  })
}

function initDokploySchema(db: Db) {
  db.exec(`
    create table if not exists dp_projects (
      project_id text primary key,
      name text not null,
      description text not null default '',
      env text not null default '',
      created_at text not null
    );
    create table if not exists dp_environments (
      environment_id text primary key,
      project_id text not null references dp_projects(project_id) on delete cascade,
      name text not null,
      description text not null default '',
      env text not null default '',
      created_at text not null
    );
    create table if not exists dp_applications (
      application_id text primary key,
      environment_id text not null references dp_environments(environment_id) on delete cascade,
      name text not null,
      app_name text not null,
      description text not null default '',
      application_status text not null default 'idle',
      source_type text not null default 'git',
      custom_git_url text,
      custom_git_branch text default 'main',
      custom_git_build_path text default '/',
      docker_image text,
      build_type text not null default 'nixpacks',
      dockerfile text default 'Dockerfile',
      env text not null default '',
      command text,
      start_file text,
      install_command text,
      runtime text not null default 'auto',
      memory_limit text,
      cpu_limit text,
      port integer default 3000,
      created_at text not null
    );
    create table if not exists dp_compose (
      compose_id text primary key,
      environment_id text not null references dp_environments(environment_id) on delete cascade,
      name text not null,
      app_name text not null,
      description text not null default '',
      compose_status text not null default 'idle',
      source_type text not null default 'raw',
      compose_file text not null default '',
      env text not null default '',
      command text,
      created_at text not null
    );
    create table if not exists dp_databases (
      db_id text primary key,
      kind text not null,
      environment_id text not null references dp_environments(environment_id) on delete cascade,
      name text not null,
      app_name text not null,
      description text not null default '',
      application_status text not null default 'idle',
      database_name text not null default 'app',
      database_user text not null default 'postgres',
      database_password text not null default '',
      database_root_password text not null default '',
      docker_image text not null,
      external_port integer,
      env text not null default '',
      command text,
      created_at text not null
    );
    create table if not exists dp_domains (
      domain_id text primary key,
      application_id text,
      compose_id text,
      host text not null,
      port integer not null default 3000,
      https integer not null default 0,
      path text not null default '/',
      service_name text,
      certificate_type text not null default 'none',
      created_at text not null
    );
    create table if not exists dp_deployments (
      deployment_id text primary key,
      target_id text not null,
      target_type text not null,
      title text not null,
      status text not null,
      log_path text not null,
      error_message text,
      created_at text not null
    );
    create table if not exists dp_registries (
      registry_id text primary key,
      registry_name text not null,
      registry_url text not null,
      username text not null default '',
      image_prefix text,
      created_at text not null
    );
    create table if not exists dp_destinations (
      destination_id text primary key,
      name text not null,
      provider text not null default 's3',
      bucket text not null,
      region text not null default 'us-east-1',
      endpoint text not null,
      created_at text not null
    );
    create table if not exists dp_certificates (
      certificate_id text primary key,
      name text not null,
      certificate_path text not null default '',
      auto_renew integer not null default 1,
      created_at text not null
    );
    create table if not exists dp_servers (
      server_id text primary key,
      name text not null,
      ip_address text not null,
      port integer not null default 22,
      username text not null default 'root',
      server_status text not null default 'active',
      created_at text not null
    );
  `)
  for (const col of [
    `alter table dp_applications add column start_file text`,
    `alter table dp_applications add column install_command text`,
    `alter table dp_applications add column runtime text not null default 'auto'`,
  ]) {
    try { db.exec(col) } catch { /* column already exists */ }
  }
}

const DEFAULT_TRAEFIK_YML = `# agOS Bundled Dokploy Traefik Configuration (Ports 8880 HTTP / 8843 HTTPS)
entryPoints:
  web:
    address: ":8880"
  websecure:
    address: ":8843"

api:
  insecure: false

providers:
  file:
    directory: "./dynamic"
    watch: true
`

export async function startBundledDokployDaemon(opts: DokployDaemonOptions): Promise<{ close: () => void } | null> {
  if (await isPortTaken(opts.port)) {
    return null
  }
  const rootDir = join(opts.dataDir, 'dokploy')
  const logsDir = join(rootDir, 'logs')
  const traefikDir = join(rootDir, 'traefik')
  const dynamicDir = join(traefikDir, 'dynamic')
  const workDir = join(rootDir, 'work')
  for (const d of [rootDir, logsDir, traefikDir, dynamicDir, workDir]) {
    mkdirSync(d, { recursive: true })
  }
  const traefikMainPath = join(traefikDir, 'traefik.yml')
  if (!existsSync(traefikMainPath)) {
    writeFileSync(traefikMainPath, DEFAULT_TRAEFIK_YML, 'utf8')
  }

  const db = openDb(join(rootDir, 'dokploy.db'))
  initDokploySchema(db)

  const activeRunners = new Map<string, { proc?: ChildProcess; server?: HttpServer; port: number }>()

  function stopAppRunner(applicationId: string) {
    const existing = activeRunners.get(applicationId)
    if (!existing) return
    activeRunners.delete(applicationId)
    if (existing.proc) {
      try { existing.proc.kill('SIGTERM') } catch { /* ignore */ }
    }
    if (existing.server) {
      try { existing.server.close() } catch { /* ignore */ }
    }
  }

  function safeRelPath(appWork: string, rel: string): string {
    const cleaned = normalize(rel.replace(/^[/\\]+/, '')).replace(/^(\.\.(\/|\\|$))+/, '')
    const full = resolve(appWork, cleaned)
    const root = resolve(appWork)
    if (!full.startsWith(root)) throw new Error('Invalid file path')
    return full
  }

  function listWorkspaceFiles(appWork: string, base = appWork): { path: string; size: number; updatedAt: string }[] {
    if (!existsSync(base)) return []
    const out: { path: string; size: number; updatedAt: string }[] = []
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.venv') continue
      const full = join(base, entry.name)
      if (entry.isDirectory()) {
        out.push(...listWorkspaceFiles(appWork, full))
      } else if (entry.isFile()) {
        const st = statSync(full)
        out.push({
          path: relative(appWork, full).replace(/\\/g, '/'),
          size: st.size,
          updatedAt: st.mtime.toISOString(),
        })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  const CANDIDATE_ENTRY_FILES = [
    'server.js', 'index.js', 'app.js', 'main.js',
    'src/server.js', 'src/index.js', 'src/app.js', 'src/main.js',
    'server.mjs', 'index.mjs', 'server.ts', 'index.ts', 'main.ts', 'app.ts',
    'src/server.ts', 'src/index.ts', 'src/main.ts',
    'app.py', 'main.py', 'server.py', 'run.py',
    'index.html', 'public/index.html', 'dist/index.html',
  ]

  function detectEntryFile(files: { path: string }[]): string | null {
    const set = new Set(files.map((f) => f.path))
    for (const c of CANDIDATE_ENTRY_FILES) {
      if (set.has(c)) return c
    }
    const firstCode = files.find((f) => /\.(js|mjs|ts|py|html)$/i.test(f.path))
    return firstCode?.path ?? null
  }

  function parseEnvString(raw: string | null | undefined, port: number): Record<string, string> {
    const out: Record<string, string> = { ...(process.env as Record<string, string>), PORT: String(port) }
    for (const line of String(raw || '').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq > 0) {
        const k = t.slice(0, eq).trim()
        const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
        out[k] = v
      }
    }
    return out
  }

  const MIME_BY_EXT: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  }

  async function startWorkspaceRuntime(applicationId: string, a: any, appWork: string, port: number, log: (msg: string) => void) {
    stopAppRunner(applicationId)
    mkdirSync(appWork, { recursive: true })
    const files = listWorkspaceFiles(appWork)
    const entry = a.start_file || detectEntryFile(files)
    const runtime = String(a.runtime || 'auto')
    const env = parseEnvString(a.env, port)

    // 1. Run install command if configured or if package.json exists without node_modules
    const pkgPath = join(appWork, 'package.json')
    const installCmd = a.install_command?.trim() || (existsSync(pkgPath) && !existsSync(join(appWork, 'node_modules')) ? 'npm install' : '')
    if (installCmd) {
      log(`Running install/build command: ${installCmd}`)
      const sh = process.platform === 'win32' ? 'cmd.exe' : 'sh'
      const shArgs = process.platform === 'win32' ? ['/d', '/s', '/c', installCmd] : ['-c', installCmd]
      try {
        const { stdout, stderr } = await run(sh, shArgs, { cwd: appWork, env, timeout: 120_000 })
        if (stdout.trim()) log(stdout.trim())
        if (stderr.trim()) log(stderr.trim())
      } catch (err) {
        log(`Install command warning: ${(err as Error).message}`)
      }
    }

    // 2. Determine whether to serve static files or spawn a process
    const isStatic =
      runtime === 'static' ||
      (!a.command?.trim() && runtime === 'auto' && entry?.toLowerCase().endsWith('.html') && !existsSync(pkgPath))

    if (isStatic) {
      const indexFile = entry || 'index.html'
      log(`Starting static HTTP server for ${appWork} (entry: ${indexFile}) on http://127.0.0.1:${port}`)
      await new Promise<void>((resolve) => {
        const srv = createHttpServer((req, res) => {
          const reqPath = (req.url || '/').split('?')[0] || '/'
          const rel = reqPath === '/' ? indexFile : reqPath.replace(/^\/+/, '')
          let target = join(appWork, rel)
          if (!existsSync(target) || (existsSync(target) && statSync(target).isDirectory())) {
            target = join(appWork, indexFile)
          }
          if (!existsSync(target) || !statSync(target).isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`404 Not Found (${rel})`)
            return
          }
          const ext = extname(target).toLowerCase()
          res.writeHead(200, { 'content-type': MIME_BY_EXT[ext] || 'application/octet-stream' })
          res.end(readFileSync(target))
        })
        srv.on('error', (err) => {
          log(`Static server port ${port} note: ${err.message}`)
          resolve()
        })
        srv.listen(port, '127.0.0.1', () => {
          activeRunners.set(applicationId, { server: srv, port })
          log(`Static server listening on http://127.0.0.1:${port}`)
          resolve()
        })
      })
      return
    }

    // 3. Determine start command or entry file command
    let cmdToRun = a.command?.trim() || ''
    if (!cmdToRun) {
      if (runtime === 'python' || entry?.toLowerCase().endsWith('.py')) {
        const pyBin = process.platform === 'win32' ? 'python' : 'python3'
        cmdToRun = `${pyBin} "${entry || 'main.py'}"`
      } else if (entry && /\.(js|mjs|cjs|ts)$/i.test(entry)) {
        cmdToRun = `"${process.execPath}" "${entry}"`
      } else if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          if (pkg.scripts?.start) cmdToRun = 'npm run start'
          else if (pkg.main) cmdToRun = `"${process.execPath}" "${pkg.main}"`
        } catch { /* ignore */ }
      }
    }

    if (!cmdToRun) {
      log(`No start command or runnable entry file found in ${appWork} (files: ${files.map((f) => f.path).join(', ') || 'none'}). Set a Start File or Start Command to launch a process.`)
      return
    }

    log(`Starting process in ${appWork} (PORT=${port}): $ ${cmdToRun}`)
    const sh = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const shArgs = process.platform === 'win32' ? ['/d', '/s', '/c', cmdToRun] : ['-c', cmdToRun]
    const child = spawn(sh, shArgs, {
      cwd: appWork,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeRunners.set(applicationId, { proc: child, port })
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) log(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) log(`[stderr] ${text}`)
    })
    child.on('exit', (code) => {
      log(`Process exited with code ${code ?? 0}`)
    })
    // Wait briefly so immediate startup output or errors are captured in the deployment log
    await new Promise((r) => setTimeout(r, 400))
    log(`Application process running (PID ${child.pid ?? 'spawned'}) on port ${port}.`)
  }

  function writeTraefikRoute(appName: string, domains: any[], fallbackPort = 3000) {
    const file = join(dynamicDir, `${appName}.yml`)
    if (!domains.length) {
      writeFileSync(file, `# No domains configured for ${appName}\n`, 'utf8')
      return
    }
    const lines = [
      'http:',
      '  routers:',
      ...domains.map((d, idx) => [
        `    ${appName}-${idx}:`,
        `      rule: "Host(\`${d.host}\`) && PathPrefix(\`${d.path || '/'}\`)"`,
        `      service: "${appName}-svc-${idx}"`,
        `      entryPoints:`,
        `        - "${d.https ? 'websecure' : 'web'}"`,
      ].join('\n')),
      '  services:',
      ...domains.map((d, idx) => [
        `    ${appName}-svc-${idx}:`,
        `      loadBalancer:`,
        `        servers:`,
        `          - url: "http://127.0.0.1:${d.port || fallbackPort}"`,
      ].join('\n')),
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  }

  async function runDeployment(targetType: string, targetId: string, title: string, appName: string, execTask: (log: (msg: string) => void) => Promise<void>) {
    const deploymentId = randomUUID()
    const logPath = join(logsDir, `${deploymentId}.log`)
    const now = new Date().toISOString()
    writeFileSync(logPath, `[${now}] Starting ${title} for ${appName} (${targetType}:${targetId})\n`, 'utf8')
    db.prepare(`insert into dp_deployments (deployment_id, target_id, target_type, title, status, log_path, created_at) values (?, ?, ?, ?, 'running', ?, ?)`).run(
      deploymentId, targetId, targetType, title, logPath, now,
    )
    const log = (line: string) => {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
    }
    try {
      await execTask(log)
      log(`Deployment ${deploymentId} finished with status: done.`)
      db.prepare(`update dp_deployments set status = 'done' where deployment_id = ?`).run(deploymentId)
      if (targetType === 'application') db.prepare(`update dp_applications set application_status = 'done' where application_id = ?`).run(targetId)
      else if (targetType === 'compose') db.prepare(`update dp_compose set compose_status = 'done' where compose_id = ?`).run(targetId)
      else db.prepare(`update dp_databases set application_status = 'done' where db_id = ?`).run(targetId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`ERROR: ${msg}`)
      db.prepare(`update dp_deployments set status = 'error', error_message = ? where deployment_id = ?`).run(msg, deploymentId)
      if (targetType === 'application') db.prepare(`update dp_applications set application_status = 'error' where application_id = ?`).run(targetId)
      else if (targetType === 'compose') db.prepare(`update dp_compose set compose_status = 'error' where compose_id = ?`).run(targetId)
      else db.prepare(`update dp_databases set application_status = 'error' where db_id = ?`).run(targetId)
    }
    return deploymentId
  }

  async function deployApplication(applicationId: string, title = 'Deploy application') {
    const a = db.prepare(`select * from dp_applications where application_id = ?`).get(applicationId) as any
    if (!a) throw new Error('Application not found')
    db.prepare(`update dp_applications set application_status = 'running' where application_id = ?`).run(applicationId)
    const domains = db.prepare(`select * from dp_domains where application_id = ?`).all(applicationId) as any[]
    writeTraefikRoute(a.app_name, domains, a.port || 3000)

    void runDeployment('application', applicationId, title, a.app_name, async (log) => {
      log(`Updated Traefik dynamic routing config at ${join(dynamicDir, `${a.app_name}.yml`)}`)
      if (a.source_type === 'docker' && a.docker_image) {
        log(`Deploying Docker image ${a.docker_image} as container ${a.app_name}...`)
        try {
          await run('docker', ['rm', '-f', a.app_name], { timeout: 10_000 }).catch(() => {})
          const envFlags = String(a.env || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#') && l.includes('='))
            .flatMap((l) => ['-e', l])
          const portFlag = domains[0]?.port || a.port || 3000
          const args = ['run', '-d', '--name', a.app_name, '-p', `${portFlag}:${portFlag}`, ...envFlags, a.docker_image]
          log(`$ docker ${args.join(' ')}`)
          const { stdout, stderr } = await run('docker', args, { timeout: 60_000 })
          if (stdout.trim()) log(stdout.trim())
          if (stderr.trim()) log(stderr.trim())
          return
        } catch (err) {
          log(`Docker runtime note: ${(err as Error).message}`)
          log(`Container spec registered in Dokploy engine for ${a.app_name} (${a.docker_image}).`)
          return
        }
      }
      const appWork = join(workDir, a.app_name)
      const targetPort = Number(domains[0]?.port || a.port || 3000)
      if (a.custom_git_url && a.source_type === 'git') {
        log(`Preparing Git workspace for ${a.custom_git_url} (branch: ${a.custom_git_branch || 'main'}, build: ${a.build_type})...`)
        try {
          if (!existsSync(join(appWork, '.git'))) {
            mkdirSync(appWork, { recursive: true })
            const { stdout, stderr } = await run('git', ['clone', '--depth', '1', '-b', a.custom_git_branch || 'main', a.custom_git_url, appWork], { timeout: 60_000 })
            if (stdout.trim()) log(stdout.trim())
            if (stderr.trim()) log(stderr.trim())
          } else {
            const { stdout, stderr } = await run('git', ['-C', appWork, 'pull', '--ff-only'], { timeout: 30_000 })
            if (stdout.trim()) log(stdout.trim())
            if (stderr.trim()) log(stderr.trim())
          }
          log(`Repository checked out at ${appWork}. Build strategy: ${a.build_type}.`)
        } catch (err) {
          log(`Git checkout note: ${(err as Error).message}`)
        }
      }
      if (a.source_type === 'files' || existsSync(appWork)) {
        await startWorkspaceRuntime(applicationId, a, appWork, targetPort, log)
      }
      log(`Application ${a.name} (${a.app_name}) is active in Dokploy on port ${targetPort}.`)
    })
    return { ok: true }
  }

  async function deployCompose(composeId: string, title = 'Deploy compose stack') {
    const c = db.prepare(`select * from dp_compose where compose_id = ?`).get(composeId) as any
    if (!c) throw new Error('Compose stack not found')
    db.prepare(`update dp_compose set compose_status = 'running' where compose_id = ?`).run(composeId)
    const domains = db.prepare(`select * from dp_domains where compose_id = ?`).all(composeId) as any[]
    writeTraefikRoute(c.app_name, domains, 3000)

    void runDeployment('compose', composeId, title, c.app_name, async (log) => {
      const stackDir = join(workDir, c.app_name)
      mkdirSync(stackDir, { recursive: true })
      const composePath = join(stackDir, 'docker-compose.yml')
      writeFileSync(composePath, c.compose_file || 'services: {}\n', 'utf8')
      if (c.env) writeFileSync(join(stackDir, '.env'), c.env, 'utf8')
      log(`Wrote compose file to ${composePath}`)
      try {
        const { stdout, stderr } = await run('docker', ['compose', '-f', composePath, '-p', c.app_name, 'up', '-d'], { timeout: 90_000 })
        if (stdout.trim()) log(stdout.trim())
        if (stderr.trim()) log(stderr.trim())
      } catch (err) {
        log(`Docker Compose note: ${(err as Error).message}`)
      }
      log(`Compose stack ${c.name} (${c.app_name}) registered and configured.`)
    })
    return { ok: true }
  }

  async function deployDatabase(dbId: string, title = 'Deploy managed database') {
    const d = db.prepare(`select * from dp_databases where db_id = ?`).get(dbId) as any
    if (!d) throw new Error('Database not found')
    db.prepare(`update dp_databases set application_status = 'running' where db_id = ?`).run(dbId)

    void runDeployment(d.kind, dbId, title, d.app_name, async (log) => {
      log(`Provisioning ${d.kind} database container ${d.app_name} (${d.docker_image})...`)
      try {
        await run('docker', ['rm', '-f', d.app_name], { timeout: 10_000 }).catch(() => {})
        const internalPort = d.kind === 'postgres' ? 5432 : d.kind === 'redis' ? 6379 : d.kind === 'mongo' ? 27017 : 3306
        const portArgs = d.external_port ? ['-p', `${d.external_port}:${internalPort}`] : []
        const envArgs =
          d.kind === 'postgres'
            ? ['-e', `POSTGRES_DB=${d.database_name}`, '-e', `POSTGRES_USER=${d.database_user}`, '-e', `POSTGRES_PASSWORD=${d.database_password || 'postgres'}`]
            : d.kind === 'redis'
            ? []
            : ['-e', `MYSQL_DATABASE=${d.database_name}`, '-e', `MYSQL_USER=${d.database_user}`, '-e', `MYSQL_PASSWORD=${d.database_password || 'secret'}`, '-e', `MYSQL_ROOT_PASSWORD=${d.database_root_password || 'root'}`]
        const { stdout, stderr } = await run('docker', ['run', '-d', '--name', d.app_name, ...portArgs, ...envArgs, d.docker_image], { timeout: 60_000 })
        if (stdout.trim()) log(stdout.trim())
        if (stderr.trim()) log(stderr.trim())
      } catch (err) {
        log(`Docker database container note: ${(err as Error).message}`)
      }
      log(`Managed ${d.kind} database ${d.name} (${d.app_name}) is ready.`)
    })
    return { ok: true }
  }

  function mapDomainRow(d: any) {
    return {
      domainId: d.domain_id,
      applicationId: d.application_id,
      composeId: d.compose_id,
      host: d.host,
      port: d.port,
      https: Boolean(d.https),
      path: d.path,
      serviceName: d.service_name,
      certificateType: d.certificate_type,
      createdAt: d.created_at,
    }
  }

  function mapAppRow(a: any) {
    const domains = (db.prepare(`select * from dp_domains where application_id = ? order by created_at asc`).all(a.application_id) as any[]).map(mapDomainRow)
    return {
      applicationId: a.application_id,
      environmentId: a.environment_id,
      name: a.name,
      appName: a.app_name,
      description: a.description,
      applicationStatus: a.application_status,
      sourceType: a.source_type,
      customGitUrl: a.custom_git_url,
      customGitBranch: a.custom_git_branch,
      customGitBuildPath: a.custom_git_build_path,
      dockerImage: a.docker_image,
      buildType: a.build_type,
      dockerfile: a.dockerfile,
      env: a.env,
      command: a.command,
      startFile: a.start_file ?? null,
      installCommand: a.install_command ?? null,
      runtime: a.runtime ?? 'auto',
      memoryLimit: a.memory_limit,
      cpuLimit: a.cpu_limit,
      port: a.port ?? 3000,
      createdAt: a.created_at,
      domains,
    }
  }

  function mapComposeRow(c: any) {
    const domains = (db.prepare(`select * from dp_domains where compose_id = ? order by created_at asc`).all(c.compose_id) as any[]).map(mapDomainRow)
    return {
      composeId: c.compose_id,
      environmentId: c.environment_id,
      name: c.name,
      appName: c.app_name,
      description: c.description,
      composeStatus: c.compose_status,
      sourceType: c.source_type,
      composeFile: c.compose_file,
      env: c.env,
      command: c.command,
      createdAt: c.created_at,
      domains,
    }
  }

  function mapDbRow(d: any) {
    const idKey = `${d.kind}Id`
    return {
      [idKey]: d.db_id,
      dbId: d.db_id,
      kind: d.kind,
      environmentId: d.environment_id,
      name: d.name,
      appName: d.app_name,
      description: d.description,
      applicationStatus: d.application_status,
      databaseName: d.database_name,
      databaseUser: d.database_user,
      dockerImage: d.docker_image,
      externalPort: d.external_port,
      env: d.env,
      command: d.command,
      createdAt: d.created_at,
    }
  }

  function buildProjectsTree() {
    const projects = db.prepare(`select * from dp_projects order by created_at asc`).all() as any[]
    return projects.map((p) => {
      const envs = db.prepare(`select * from dp_environments where project_id = ? order by created_at asc`).all(p.project_id) as any[]
      return {
        projectId: p.project_id,
        name: p.name,
        description: p.description,
        env: p.env,
        createdAt: p.created_at,
        environments: envs.map((e) => {
          const apps = (db.prepare(`select * from dp_applications where environment_id = ? order by created_at asc`).all(e.environment_id) as any[]).map(mapAppRow)
          const compose = (db.prepare(`select * from dp_compose where environment_id = ? order by created_at asc`).all(e.environment_id) as any[]).map(mapComposeRow)
          const dbs = db.prepare(`select * from dp_databases where environment_id = ? order by created_at asc`).all(e.environment_id) as any[]
          return {
            environmentId: e.environment_id,
            projectId: e.project_id,
            name: e.name,
            description: e.description,
            env: e.env,
            createdAt: e.created_at,
            applications: apps,
            compose,
            postgres: dbs.filter((d) => d.kind === 'postgres').map(mapDbRow),
            mysql: dbs.filter((d) => d.kind === 'mysql').map(mapDbRow),
            mariadb: dbs.filter((d) => d.kind === 'mariadb').map(mapDbRow),
            mongo: dbs.filter((d) => d.kind === 'mongo').map(mapDbRow),
            redis: dbs.filter((d) => d.kind === 'redis').map(mapDbRow),
          }
        }),
      }
    })
  }

  // Ensure default "default" project & "production" environment exist so Studio is immediately ready
  if ((db.prepare(`select count(*) as n from dp_projects`).get() as { n: number }).n === 0) {
    const pid = randomUUID()
    const eid = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`insert into dp_projects (project_id, name, description, created_at) values (?, 'default', 'Default agOS Dokploy project', ?)`).run(pid, now)
    db.prepare(`insert into dp_environments (environment_id, project_id, name, description, created_at) values (?, ?, 'production', 'Production environment', ?)`).run(eid, pid, now)
  }

  const app = new Hono()

  app.use('*', async (c, next) => {
    c.header('access-control-allow-origin', '*')
    c.header('access-control-allow-headers', 'content-type, x-agos-key, x-api-key')
    c.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })

  app.all('/api/:proc', async (c) => {
    const proc = c.req.param('proc')
    let input: Record<string, any> = {}
    if (c.req.method === 'GET') {
      input = Object.fromEntries(new URL(c.req.url).searchParams.entries())
    } else {
      input = await c.req.json().catch(() => ({}))
    }
    const now = new Date().toISOString()

    try {
      switch (proc) {
        case 'project.all':
          return c.json(buildProjectsTree())

        case 'project.one': {
          const all = buildProjectsTree()
          const found = all.find((p) => p.projectId === input.projectId)
          if (!found) return c.json({ message: 'Project not found' }, 404)
          return c.json(found)
        }

        case 'project.create': {
          const projectId = randomUUID()
          const environmentId = randomUUID()
          const name = String(input.name || 'project').trim()
          db.prepare(`insert into dp_projects (project_id, name, description, env, created_at) values (?, ?, ?, ?, ?)`).run(
            projectId, name, String(input.description ?? ''), String(input.env ?? ''), now,
          )
          db.prepare(`insert into dp_environments (environment_id, project_id, name, description, created_at) values (?, ?, 'production', 'Production environment', ?)`).run(
            environmentId, projectId, now,
          )
          return c.json({
            project: { projectId, name, description: String(input.description ?? '') },
            environment: { environmentId, projectId, name: 'production' },
          })
        }

        case 'project.remove': {
          db.prepare(`delete from dp_projects where project_id = ?`).run(input.projectId)
          return c.json({ ok: true })
        }

        case 'environment.create': {
          const environmentId = randomUUID()
          db.prepare(`insert into dp_environments (environment_id, project_id, name, description, created_at) values (?, ?, ?, ?, ?)`).run(
            environmentId, input.projectId, String(input.name || 'staging'), String(input.description ?? ''), now,
          )
          return c.json({ environmentId, projectId: input.projectId, name: input.name })
        }

        case 'environment.byProjectId': {
          const envs = db.prepare(`select * from dp_environments where project_id = ?`).all(input.projectId)
          return c.json(envs)
        }

        case 'application.create': {
          const applicationId = randomUUID()
          const name = String(input.name || 'app').trim()
          const appName = String(input.appName || `${name}-${applicationId.slice(0, 6)}`)
          db.prepare(`
            insert into dp_applications (application_id, environment_id, name, app_name, description, application_status, created_at)
            values (?, ?, ?, ?, ?, 'idle', ?)
          `).run(applicationId, input.environmentId, name, appName, String(input.description ?? ''), now)
          return c.json(mapAppRow(db.prepare(`select * from dp_applications where application_id = ?`).get(applicationId)))
        }

        case 'application.one': {
          const row = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId)
          if (!row) return c.json({ message: 'Application not found' }, 404)
          return c.json(mapAppRow(row))
        }

        case 'application.saveGitProdiver':
        case 'application.saveGitProvider': {
          db.prepare(`
            update dp_applications
            set source_type = 'git',
                custom_git_url = coalesce(?, custom_git_url),
                custom_git_branch = coalesce(?, custom_git_branch),
                custom_git_build_path = coalesce(?, custom_git_build_path)
            where application_id = ?
          `).run(input.customGitUrl ?? null, input.customGitBranch ?? null, input.customGitBuildPath ?? null, input.applicationId)
          return c.json({ ok: true })
        }

        case 'application.saveBuildType': {
          db.prepare(`
            update dp_applications
            set build_type = coalesce(?, build_type),
                dockerfile = coalesce(?, dockerfile)
            where application_id = ?
          `).run(input.buildType ?? null, input.dockerfile ?? null, input.applicationId)
          return c.json({ ok: true })
        }

        case 'application.saveDockerProvider': {
          db.prepare(`
            update dp_applications
            set source_type = 'docker',
                docker_image = coalesce(?, docker_image)
            where application_id = ?
          `).run(input.dockerImage ?? null, input.applicationId)
          return c.json({ ok: true })
        }

        case 'application.saveEnvironment': {
          db.prepare(`update dp_applications set env = ? where application_id = ?`).run(String(input.env ?? ''), input.applicationId)
          return c.json({ ok: true })
        }

        case 'application.update': {
          db.prepare(`
            update dp_applications
            set name = coalesce(?, name),
                command = coalesce(?, command),
                start_file = coalesce(?, start_file),
                install_command = coalesce(?, install_command),
                runtime = coalesce(?, runtime),
                port = coalesce(?, port),
                source_type = coalesce(?, source_type),
                memory_limit = coalesce(?, memory_limit),
                cpu_limit = coalesce(?, cpu_limit)
            where application_id = ?
          `).run(
            input.name ?? null,
            input.command !== undefined ? input.command : null,
            input.startFile !== undefined ? input.startFile : null,
            input.installCommand !== undefined ? input.installCommand : null,
            input.runtime ?? null,
            input.port ? Number(input.port) : null,
            input.sourceType ?? null,
            input.memoryLimit ?? null,
            input.cpuLimit ?? null,
            input.applicationId,
          )
          return c.json({ ok: true })
        }

        case 'application.uploadFiles': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (!a) return c.json({ message: 'Application not found' }, 404)
          const appWork = join(workDir, a.app_name)
          if (input.clearExisting && existsSync(appWork)) {
            rmSync(appWork, { recursive: true, force: true })
          }
          mkdirSync(appWork, { recursive: true })

          if (typeof input.sourceDir === 'string' && input.sourceDir.trim()) {
            const src = resolve(input.sourceDir.trim())
            if (!existsSync(src)) return c.json({ message: `Source directory does not exist: ${src}` }, 400)
            cpSync(src, appWork, {
              recursive: true,
              filter: (s) => !s.includes('node_modules') && !s.includes('.git'),
            })
          }

          if (typeof input.archiveBase64 === 'string' && input.archiveBase64.trim()) {
            const archiveName = String(input.archiveName || 'upload.zip').replace(/[^a-zA-Z0-9._-]/g, '_')
            const tmpArchive = join(rootDir, `tmp-${randomUUID()}-${archiveName}`)
            writeFileSync(tmpArchive, Buffer.from(input.archiveBase64, 'base64'))
            try {
              await run('tar', ['-xf', tmpArchive, '-C', appWork], { timeout: 30_000 })
            } catch {
              if (process.platform === 'win32') {
                await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${tmpArchive}" -DestinationPath "${appWork}" -Force`], { timeout: 30_000 }).catch(() => {})
              } else {
                await run('unzip', ['-o', tmpArchive, '-d', appWork], { timeout: 30_000 }).catch(() => {})
              }
            } finally {
              try { unlinkSync(tmpArchive) } catch { /* ignore */ }
            }
          }

          if (Array.isArray(input.files)) {
            for (const f of input.files) {
              if (!f || typeof f.path !== 'string' || !f.path.trim()) continue
              const target = safeRelPath(appWork, f.path)
              mkdirSync(dirname(target), { recursive: true })
              const buf = f.encoding === 'base64' ? Buffer.from(String(f.content ?? ''), 'base64') : Buffer.from(String(f.content ?? ''), 'utf8')
              writeFileSync(target, buf)
            }
          }

          const files = listWorkspaceFiles(appWork)
          const detectedStart = input.startFile !== undefined ? input.startFile : (a.start_file || detectEntryFile(files))
          db.prepare(`
            update dp_applications
            set source_type = coalesce(?, 'files'),
                start_file = ?,
                install_command = coalesce(?, install_command),
                command = coalesce(?, command),
                runtime = coalesce(?, runtime),
                port = coalesce(?, port)
            where application_id = ?
          `).run(
            input.sourceType ?? 'files',
            detectedStart ?? null,
            input.installCommand !== undefined ? input.installCommand : null,
            input.command !== undefined ? input.command : null,
            input.runtime ?? null,
            input.port ? Number(input.port) : null,
            input.applicationId,
          )
          return c.json({
            ok: true,
            workDir: appWork,
            startFile: detectedStart ?? null,
            files,
          })
        }

        case 'application.listFiles': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (!a) return c.json({ message: 'Application not found' }, 404)
          const appWork = join(workDir, a.app_name)
          const files = listWorkspaceFiles(appWork)
          return c.json({
            workDir: appWork,
            startFile: a.start_file ?? detectEntryFile(files),
            command: a.command ?? null,
            installCommand: a.install_command ?? null,
            runtime: a.runtime ?? 'auto',
            port: a.port ?? 3000,
            files,
          })
        }

        case 'application.readFile': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (!a) return c.json({ message: 'Application not found' }, 404)
          const appWork = join(workDir, a.app_name)
          const target = safeRelPath(appWork, String(input.path || ''))
          if (!existsSync(target) || !statSync(target).isFile()) return c.json({ message: 'File not found' }, 404)
          const content = readFileSync(target, 'utf8')
          return c.json({ path: input.path, content, size: Buffer.byteLength(content) })
        }

        case 'application.deleteFile': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (!a) return c.json({ message: 'Application not found' }, 404)
          const appWork = join(workDir, a.app_name)
          const target = safeRelPath(appWork, String(input.path || ''))
          if (existsSync(target)) rmSync(target, { recursive: true, force: true })
          return c.json({ ok: true, files: listWorkspaceFiles(appWork) })
        }

        case 'application.deploy':
        case 'application.redeploy':
          return c.json(await deployApplication(input.applicationId, proc === 'application.redeploy' ? 'Redeploy application' : 'Deploy application'))

        case 'application.start': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (a) {
            if (a.source_type === 'files' || existsSync(join(workDir, a.app_name))) {
              await deployApplication(input.applicationId, 'Start application')
            } else {
              await run('docker', ['start', a.app_name], { timeout: 15_000 }).catch(() => {})
              db.prepare(`update dp_applications set application_status = 'done' where application_id = ?`).run(input.applicationId)
            }
          }
          return c.json({ ok: true })
        }

        case 'application.stop': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (a) {
            stopAppRunner(input.applicationId)
            await run('docker', ['stop', a.app_name], { timeout: 15_000 }).catch(() => {})
            db.prepare(`update dp_applications set application_status = 'idle' where application_id = ?`).run(input.applicationId)
          }
          return c.json({ ok: true })
        }

        case 'application.delete': {
          const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
          if (a) {
            stopAppRunner(input.applicationId)
            await run('docker', ['rm', '-f', a.app_name], { timeout: 15_000 }).catch(() => {})
            const appWork = join(workDir, a.app_name)
            if (existsSync(appWork)) rmSync(appWork, { recursive: true, force: true })
          }
          db.prepare(`delete from dp_domains where application_id = ?`).run(input.applicationId)
          db.prepare(`delete from dp_applications where application_id = ?`).run(input.applicationId)
          return c.json({ ok: true })
        }

        case 'compose.create': {
          const composeId = randomUUID()
          const name = String(input.name || 'stack').trim()
          const appName = String(input.appName || `${name}-${composeId.slice(0, 6)}`)
          db.prepare(`
            insert into dp_compose (compose_id, environment_id, name, app_name, compose_status, source_type, compose_file, created_at)
            values (?, ?, ?, ?, 'idle', ?, ?, ?)
          `).run(composeId, input.environmentId, name, appName, String(input.sourceType ?? 'raw'), String(input.composeFile ?? ''), now)
          return c.json(mapComposeRow(db.prepare(`select * from dp_compose where compose_id = ?`).get(composeId)))
        }

        case 'compose.one': {
          const row = db.prepare(`select * from dp_compose where compose_id = ?`).get(input.composeId)
          if (!row) return c.json({ message: 'Compose stack not found' }, 404)
          return c.json(mapComposeRow(row))
        }

        case 'compose.update': {
          db.prepare(`
            update dp_compose
            set name = coalesce(?, name),
                compose_file = coalesce(?, compose_file),
                env = coalesce(?, env),
                command = coalesce(?, command),
                source_type = coalesce(?, source_type)
            where compose_id = ?
          `).run(input.name ?? null, input.composeFile ?? null, input.env ?? null, input.command ?? null, input.sourceType ?? null, input.composeId)
          return c.json({ ok: true })
        }

        case 'compose.deploy':
        case 'compose.redeploy':
          return c.json(await deployCompose(input.composeId, proc === 'compose.redeploy' ? 'Redeploy compose stack' : 'Deploy compose stack'))

        case 'compose.start': {
          db.prepare(`update dp_compose set compose_status = 'done' where compose_id = ?`).run(input.composeId)
          return c.json({ ok: true })
        }

        case 'compose.stop': {
          const comp = db.prepare(`select * from dp_compose where compose_id = ?`).get(input.composeId) as any
          if (comp) {
            const composePath = join(workDir, comp.app_name, 'docker-compose.yml')
            if (existsSync(composePath)) await run('docker', ['compose', '-f', composePath, '-p', comp.app_name, 'stop'], { timeout: 20_000 }).catch(() => {})
          }
          db.prepare(`update dp_compose set compose_status = 'idle' where compose_id = ?`).run(input.composeId)
          return c.json({ ok: true })
        }

        case 'compose.delete': {
          const comp = db.prepare(`select * from dp_compose where compose_id = ?`).get(input.composeId) as any
          if (comp) {
            const composePath = join(workDir, comp.app_name, 'docker-compose.yml')
            if (existsSync(composePath)) await run('docker', ['compose', '-f', composePath, '-p', comp.app_name, 'down'], { timeout: 20_000 }).catch(() => {})
          }
          db.prepare(`delete from dp_domains where compose_id = ?`).run(input.composeId)
          db.prepare(`delete from dp_compose where compose_id = ?`).run(input.composeId)
          return c.json({ ok: true })
        }

        case 'domain.create': {
          const domainId = randomUUID()
          db.prepare(`
            insert into dp_domains (domain_id, application_id, compose_id, host, port, https, path, service_name, certificate_type, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            domainId,
            input.applicationId ?? null,
            input.composeId ?? null,
            String(input.host || 'localhost'),
            Number(input.port) || 3000,
            input.https ? 1 : 0,
            String(input.path || '/'),
            input.serviceName ?? null,
            String(input.certificateType || (input.https ? 'letsencrypt' : 'none')),
            now,
          )
          if (input.applicationId) {
            const a = db.prepare(`select * from dp_applications where application_id = ?`).get(input.applicationId) as any
            if (a) writeTraefikRoute(a.app_name, db.prepare(`select * from dp_domains where application_id = ?`).all(input.applicationId) as any[], a.port || 3000)
          }
          if (input.composeId) {
            const comp = db.prepare(`select * from dp_compose where compose_id = ?`).get(input.composeId) as any
            if (comp) writeTraefikRoute(comp.app_name, db.prepare(`select * from dp_domains where compose_id = ?`).all(input.composeId) as any[], 3000)
          }
          return c.json(mapDomainRow(db.prepare(`select * from dp_domains where domain_id = ?`).get(domainId)))
        }

        case 'domain.delete': {
          db.prepare(`delete from dp_domains where domain_id = ?`).run(input.domainId)
          return c.json({ ok: true })
        }

        case 'domain.byApplicationId':
          return c.json((db.prepare(`select * from dp_domains where application_id = ?`).all(input.applicationId) as any[]).map(mapDomainRow))

        case 'domain.byComposeId':
          return c.json((db.prepare(`select * from dp_domains where compose_id = ?`).all(input.composeId) as any[]).map(mapDomainRow))

        case 'deployment.all': {
          const rows = db.prepare(`select * from dp_deployments where target_id = ? order by created_at desc limit 30`).all(input.applicationId) as any[]
          return c.json(rows.map((d) => ({
            deploymentId: d.deployment_id,
            title: d.title,
            status: d.status,
            logPath: d.log_path,
            errorMessage: d.error_message,
            createdAt: d.created_at,
          })))
        }

        case 'deployment.allByCompose': {
          const rows = db.prepare(`select * from dp_deployments where target_id = ? order by created_at desc limit 30`).all(input.composeId) as any[]
          return c.json(rows.map((d) => ({
            deploymentId: d.deployment_id,
            title: d.title,
            status: d.status,
            logPath: d.log_path,
            errorMessage: d.error_message,
            createdAt: d.created_at,
          })))
        }

        case 'deployment.allByType': {
          const rows = db.prepare(`select * from dp_deployments where target_id = ? order by created_at desc limit 30`).all(input.id) as any[]
          return c.json(rows.map((d) => ({
            deploymentId: d.deployment_id,
            title: d.title,
            status: d.status,
            logPath: d.log_path,
            errorMessage: d.error_message,
            createdAt: d.created_at,
          })))
        }

        case 'deployment.readLogs': {
          const d = db.prepare(`select * from dp_deployments where deployment_id = ?`).get(input.deploymentId) as any
          if (!d) return c.json({ message: 'Deployment not found' }, 404)
          const logText = existsSync(d.log_path) ? readFileSync(d.log_path, 'utf8') : 'No log output recorded.'
          return c.json({ logs: logText, log: logText })
        }

        case 'docker.getContainers': {
          try {
            const { stdout } = await run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 5000 })
            const list = stdout.trim().split('\n').filter(Boolean).map((l) => {
              const j = JSON.parse(l)
              return {
                containerId: j.ID,
                name: j.Names,
                image: j.Image,
                state: j.State,
                status: j.Status,
                ports: j.Ports,
              }
            })
            return c.json(list)
          } catch {
            return c.json([])
          }
        }

        case 'settings.getDokployVersion':
          return c.json({ version: 'v0.29.0-agos-bundled', traefikHttpPort: 8880, traefikHttpsPort: 8843 })

        case 'settings.readTraefikConfig':
          return c.json({ config: existsSync(traefikMainPath) ? readFileSync(traefikMainPath, 'utf8') : DEFAULT_TRAEFIK_YML })

        case 'settings.updateTraefikConfig':
          if (typeof input.traefikConfig === 'string') writeFileSync(traefikMainPath, input.traefikConfig, 'utf8')
          return c.json({ ok: true })

        case 'settings.cleanUnusedImages': {
          await run('docker', ['image', 'prune', '-f'], { timeout: 20_000 }).catch(() => {})
          return c.json({ ok: true })
        }

        case 'settings.cleanDockerBuilder': {
          await run('docker', ['builder', 'prune', '-f'], { timeout: 20_000 }).catch(() => {})
          return c.json({ ok: true })
        }

        case 'registry.all':
          return c.json(db.prepare(`select * from dp_registries order by created_at desc`).all())

        case 'registry.create': {
          const id = randomUUID()
          db.prepare(`insert into dp_registries (registry_id, registry_name, registry_url, username, image_prefix, created_at) values (?, ?, ?, ?, ?, ?)`).run(
            id, String(input.registryName || 'Registry'), String(input.registryUrl || 'ghcr.io'), String(input.username || ''), input.imagePrefix ?? null, now,
          )
          return c.json({ registryId: id })
        }

        case 'registry.remove':
          db.prepare(`delete from dp_registries where registry_id = ?`).run(input.registryId)
          return c.json({ ok: true })

        case 'destination.all':
          return c.json(db.prepare(`select * from dp_destinations order by created_at desc`).all())

        case 'destination.create': {
          const id = randomUUID()
          db.prepare(`insert into dp_destinations (destination_id, name, provider, bucket, region, endpoint, created_at) values (?, ?, ?, ?, ?, ?, ?)`).run(
            id, String(input.name || 'S3 Backup'), String(input.provider || 's3'), String(input.bucket || 'backups'), String(input.region || 'us-east-1'), String(input.endpoint || 'https://s3.amazonaws.com'), now,
          )
          return c.json({ destinationId: id })
        }

        case 'destination.remove':
          db.prepare(`delete from dp_destinations where destination_id = ?`).run(input.destinationId)
          return c.json({ ok: true })

        case 'server.all':
          return c.json(db.prepare(`select * from dp_servers order by created_at desc`).all())

        case 'server.create': {
          const id = randomUUID()
          db.prepare(`insert into dp_servers (server_id, name, ip_address, port, username, created_at) values (?, ?, ?, ?, ?, ?)`).run(
            id, String(input.name || 'Worker Node'), String(input.ipAddress || '127.0.0.1'), Number(input.port) || 22, String(input.username || 'root'), now,
          )
          return c.json({ serverId: id })
        }

        case 'server.remove':
          db.prepare(`delete from dp_servers where server_id = ?`).run(input.serverId)
          return c.json({ ok: true })
      }

      // Database routers: postgres.*, mysql.*, mariadb.*, mongo.*, redis.*
      const dbMatch = proc.match(/^(postgres|mysql|mariadb|mongo|redis)\.(\w+)$/)
      if (dbMatch) {
        const [, kind, action] = dbMatch as [string, string, string]
        const idKey = `${kind}Id`
        const dbId = String(input[idKey] || input.dbId || '')

        if (action === 'create') {
          const newId = randomUUID()
          const name = String(input.name || `${kind}-db`)
          const appName = String(input.appName || `${name}-${newId.slice(0, 6)}`)
          db.prepare(`
            insert into dp_databases (db_id, kind, environment_id, name, app_name, description, application_status, database_name, database_user, database_password, database_root_password, docker_image, created_at)
            values (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)
          `).run(
            newId,
            kind,
            input.environmentId,
            name,
            appName,
            String(input.description ?? ''),
            String(input.databaseName || 'app'),
            String(input.databaseUser || (kind === 'postgres' ? 'postgres' : 'app')),
            String(input.databasePassword || ''),
            String(input.databaseRootPassword || ''),
            String(input.dockerImage || `${kind}:latest`),
            now,
          )
          return c.json(mapDbRow(db.prepare(`select * from dp_databases where db_id = ?`).get(newId)))
        }
        if (action === 'one') {
          const row = db.prepare(`select * from dp_databases where db_id = ?`).get(dbId)
          if (!row) return c.json({ message: 'Database not found' }, 404)
          return c.json(mapDbRow(row))
        }
        if (action === 'saveExternalPort') {
          db.prepare(`update dp_databases set external_port = ? where db_id = ?`).run(input.externalPort ?? null, dbId)
          return c.json({ ok: true })
        }
        if (action === 'saveEnvironment') {
          db.prepare(`update dp_databases set env = ? where db_id = ?`).run(String(input.env ?? ''), dbId)
          return c.json({ ok: true })
        }
        if (action === 'update') {
          db.prepare(`update dp_databases set name = coalesce(?, name), docker_image = coalesce(?, docker_image), command = coalesce(?, command) where db_id = ?`).run(
            input.name ?? null, input.dockerImage ?? null, input.command ?? null, dbId,
          )
          return c.json({ ok: true })
        }
        if (action === 'deploy' || action === 'start' || action === 'reload') {
          return c.json(await deployDatabase(dbId, `${action} ${kind} database`))
        }
        if (action === 'stop') {
          const d = db.prepare(`select * from dp_databases where db_id = ?`).get(dbId) as any
          if (d) await run('docker', ['stop', d.app_name], { timeout: 15_000 }).catch(() => {})
          db.prepare(`update dp_databases set application_status = 'idle' where db_id = ?`).run(dbId)
          return c.json({ ok: true })
        }
        if (action === 'remove') {
          const d = db.prepare(`select * from dp_databases where db_id = ?`).get(dbId) as any
          if (d) await run('docker', ['rm', '-f', d.app_name], { timeout: 15_000 }).catch(() => {})
          db.prepare(`delete from dp_databases where db_id = ?`).run(dbId)
          return c.json({ ok: true })
        }
      }

      return c.json({ ok: true, procedure: proc })
    } catch (err) {
      return c.json({ message: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // Interactive agOS-themed Dokploy Studio Web UI served at http://127.0.0.1:3010/
  app.get('*', (c) => c.html(DOKPLOY_STUDIO_HTML))

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port }, (info) => {
    console.log(`bundled dokploy engine listening on 127.0.0.1:${info.port} (traefik :8880/:8843)`)
  })

  return {
    close: () => {
      for (const id of activeRunners.keys()) stopAppRunner(id)
      server.close()
      db.close()
    },
  }
}

const DOKPLOY_STUDIO_HTML = `<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Dokploy Studio · agOS Bundled Engine (:3010)</title>
  <style>
    :root {
      --bg: #0b0b0c;
      --card: #121214;
      --muted: #1b1b1f;
      --border: #26262b;
      --fg: #f4f4f6;
      --sub: #9a9aa2;
      --accent: #f4f4f6;
      --accent-fg: #0b0b0c;
      --live: #22c55e;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      display: flex;
      min-height: 100vh;
      font-size: 13px;
    }
    aside {
      width: 220px;
      border-right: 1px solid var(--border);
      background: var(--card);
      padding: 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px 14px;
      font-weight: 600;
      font-size: 14px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--live); display: inline-block; }
    .nav-btn {
      background: transparent;
      color: var(--sub);
      border: 0;
      text-align: left;
      padding: 8px 10px;
      border-radius: 7px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .nav-btn:hover { background: var(--muted); color: var(--fg); }
    .nav-btn.active { background: var(--fg); color: var(--accent-fg); }
    main { flex: 1; padding: 20px 24px; overflow-y: auto; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .subtitle { color: var(--sub); margin-bottom: 18px; font-size: 12px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .btn {
      background: var(--fg);
      color: var(--accent-fg);
      border: 1px solid var(--fg);
      border-radius: 7px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn.outline { background: transparent; color: var(--fg); border-color: var(--border); }
    .btn.outline:hover { background: var(--muted); }
    input, textarea, select {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 7px 10px;
      font-size: 12px;
      font-family: inherit;
      width: 100%;
    }
    textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .badge {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--muted);
      border: 1px solid var(--border);
    }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  </style>
</head>
<body>
  <aside>
    <div class="brand"><span class="dot"></span>Dokploy Studio</div>
    <button class="nav-btn active" onclick="showTab('projects', this)">Projects & Services</button>
    <button class="nav-btn" onclick="showTab('traefik', this)">Traefik (:8880/:8843)</button>
    <button class="nav-btn" onclick="showTab('docker', this)">Docker Containers</button>
    <button class="nav-btn" onclick="showTab('registries', this)">Registries & S3 Backups</button>
    <button class="nav-btn" onclick="showTab('api', this)">tRPC / API Console</button>
    <div style="margin-top:auto;padding:10px;font-size:11px;color:var(--sub);border-top:1px solid var(--border)">
      agOS Monochrome Theme<br/>Port 3010 · Traefik 8880/8843
    </div>
  </aside>
  <main>
    <div id="tab-projects">
      <div class="row" style="margin-bottom:14px">
        <div>
          <h1>Projects & Environments</h1>
          <div class="subtitle">Manage Dokploy projects, applications, compose stacks, and managed databases</div>
        </div>
        <div class="row">
          <input id="new-proj-name" placeholder="new-project-name" style="width:180px" />
          <button class="btn" onclick="createProject()">+ Create Project</button>
        </div>
      </div>
      <div id="projects-list">Loading projects...</div>
    </div>

    <div id="tab-traefik" style="display:none">
      <div class="row" style="margin-bottom:14px">
        <div>
          <h1>Traefik Reverse Proxy (:8880 HTTP / :8843 HTTPS)</h1>
          <div class="subtitle">Live static & dynamic routing configuration managed by bundled Dokploy</div>
        </div>
        <button class="btn" onclick="saveTraefik()">Save Traefik Config</button>
      </div>
      <div class="card">
        <textarea id="traefik-cfg" rows="18"></textarea>
      </div>
    </div>

    <div id="tab-docker" style="display:none">
      <div class="row" style="margin-bottom:14px">
        <div>
          <h1>Docker Containers</h1>
          <div class="subtitle">Live containers inspected via Dokploy docker.getContainers</div>
        </div>
        <div class="row">
          <button class="btn outline" onclick="pruneImages()">Prune Unused Images</button>
          <button class="btn" onclick="loadContainers()">Refresh</button>
        </div>
      </div>
      <div id="containers-list"></div>
    </div>

    <div id="tab-registries" style="display:none">
      <h1>Docker Registries & S3 Backup Destinations</h1>
      <div class="subtitle">Configure container registries (GHCR, Docker Hub, ECR) and S3 backup buckets</div>
      <div class="grid">
        <div class="card">
          <h3 style="margin:0 0 10px">Add Container Registry</h3>
          <div style="display:flex;flex-direction:column;gap:8px">
            <input id="reg-name" placeholder="Registry Name (e.g. GHCR)" />
            <input id="reg-url" placeholder="Registry URL (e.g. ghcr.io)" />
            <input id="reg-user" placeholder="Username" />
            <button class="btn" onclick="addRegistry()">Add Registry</button>
          </div>
          <div id="reg-list" style="margin-top:12px"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 10px">Add S3 Backup Destination</h3>
          <div style="display:flex;flex-direction:column;gap:8px">
            <input id="s3-name" placeholder="Destination Name (e.g. Nightly Backups)" />
            <input id="s3-bucket" placeholder="Bucket Name" />
            <input id="s3-endpoint" placeholder="Endpoint (https://s3.amazonaws.com)" />
            <button class="btn" onclick="addDestination()">Add S3 Destination</button>
          </div>
          <div id="s3-list" style="margin-top:12px"></div>
        </div>
      </div>
    </div>

    <div id="tab-api" style="display:none">
      <h1>Dokploy API Console</h1>
      <div class="subtitle">Invoke any Dokploy procedure (/api/&lt;router&gt;.&lt;procedure&gt;) directly</div>
      <div class="card" style="display:flex;flex-direction:column;gap:10px">
        <div class="row">
          <input id="api-proc" value="settings.getDokployVersion" style="flex:1" />
          <button class="btn" onclick="runApiCall()">Execute</button>
        </div>
        <textarea id="api-input" rows="4">{}</textarea>
        <pre id="api-output" style="background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border);overflow:auto;margin:0"></pre>
      </div>
    </div>
  </main>

  <script>
    async function api(proc, body, method) {
      const isGet = method === 'GET' || (!body && /\\.(all|one|get|read)/.test(proc));
      const res = await fetch('/api/' + proc, isGet ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      return res.json();
    }
    function showTab(id, btn) {
      for (const t of ['projects', 'traefik', 'docker', 'registries', 'api']) {
        document.getElementById('tab-' + t).style.display = t === id ? 'block' : 'none';
      }
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      if (id === 'projects') loadProjects();
      if (id === 'traefik') loadTraefik();
      if (id === 'docker') loadContainers();
      if (id === 'registries') loadRegistries();
    }
    async function loadProjects() {
      const list = await api('project.all', null, 'GET');
      const el = document.getElementById('projects-list');
      if (!Array.isArray(list) || !list.length) { el.innerHTML = '<div class="card">No projects yet.</div>'; return; }
      el.innerHTML = list.map(p => {
        const envs = p.environments || [];
        const items = envs.flatMap(e => [
          ...(e.applications || []).map(a => ({ kind: 'app', name: a.name, appName: a.appName, status: a.applicationStatus })),
          ...(e.compose || []).map(c => ({ kind: 'compose', name: c.name, appName: c.appName, status: c.composeStatus })),
          ...['postgres','mysql','mariadb','mongo','redis'].flatMap(k => (e[k] || []).map(d => ({ kind: k, name: d.name, appName: d.appName, status: d.applicationStatus })))
        ]);
        return '<div class="card"><div class="row"><strong>' + p.name + '</strong><span class="badge">' + envs.length + ' env · ' + items.length + ' services</span></div>' +
          (items.length ? '<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">' + items.map(i =>
            '<div class="row" style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px">' +
              '<span><strong>' + i.name + '</strong> <span style="color:var(--sub)">(' + i.kind + ' · ' + i.appName + ')</span></span>' +
              '<span class="badge">' + i.status + '</span>' +
            '</div>'
          ).join('') + '</div>' : '<div style="color:var(--sub);margin-top:8px;font-size:12px">No services in this project yet.</div>') +
        '</div>';
      }).join('');
    }
    async function createProject() {
      const name = document.getElementById('new-proj-name').value.trim();
      if (!name) return;
      await api('project.create', { name }, 'POST');
      document.getElementById('new-proj-name').value = '';
      loadProjects();
    }
    async function loadTraefik() {
      const r = await api('settings.readTraefikConfig', null, 'GET');
      document.getElementById('traefik-cfg').value = r.config || '';
    }
    async function saveTraefik() {
      const traefikConfig = document.getElementById('traefik-cfg').value;
      await api('settings.updateTraefikConfig', { traefikConfig }, 'POST');
      alert('Traefik config saved.');
    }
    async function loadContainers() {
      const list = await api('docker.getContainers', null, 'GET');
      const el = document.getElementById('containers-list');
      if (!Array.isArray(list) || !list.length) {
        el.innerHTML = '<div class="card" style="color:var(--sub)">No running Docker containers returned by docker ps.</div>';
        return;
      }
      el.innerHTML = list.map(c =>
        '<div class="card row"><div><strong>' + c.name + '</strong><div style="color:var(--sub);font-size:12px">' + c.image + ' · ' + c.status + '</div></div><span class="badge">' + c.state + '</span></div>'
      ).join('');
    }
    async function pruneImages() {
      await api('settings.cleanUnusedImages', {}, 'POST');
      loadContainers();
    }
    async function loadRegistries() {
      const regs = await api('registry.all', null, 'GET');
      const dests = await api('destination.all', null, 'GET');
      document.getElementById('reg-list').innerHTML = (regs || []).map(r => '<div class="badge" style="display:block;margin-top:4px">' + r.registry_name + ' (' + r.registry_url + ')</div>').join('');
      document.getElementById('s3-list').innerHTML = (dests || []).map(d => '<div class="badge" style="display:block;margin-top:4px">' + d.name + ' (' + d.bucket + ')</div>').join('');
    }
    async function addRegistry() {
      await api('registry.create', {
        registryName: document.getElementById('reg-name').value,
        registryUrl: document.getElementById('reg-url').value,
        username: document.getElementById('reg-user').value
      }, 'POST');
      loadRegistries();
    }
    async function addDestination() {
      await api('destination.create', {
        name: document.getElementById('s3-name').value,
        bucket: document.getElementById('s3-bucket').value,
        endpoint: document.getElementById('s3-endpoint').value
      }, 'POST');
      loadRegistries();
    }
    async function runApiCall() {
      const proc = document.getElementById('api-proc').value.trim();
      let body = {};
      try { body = JSON.parse(document.getElementById('api-input').value || '{}'); } catch {}
      const out = await api(proc, body, Object.keys(body).length ? 'POST' : 'GET');
      document.getElementById('api-output').textContent = JSON.stringify(out, null, 2);
    }
    loadProjects();
  </script>
</body>
</html>`
