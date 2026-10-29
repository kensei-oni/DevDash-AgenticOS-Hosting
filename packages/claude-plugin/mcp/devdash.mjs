// DevDash tools for Claude Code (MCP over stdio: newline-delimited JSON-RPC 2.0). No dependencies, no tokens:
// calls go to this member's own agent socket, which relays them to the DevDash server, so they act as this member
// ("via Claude"). The project comes from the Claude session (DEVDASH_SESSION_ID) or the working folder.
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { teamTools } from './team.mjs' // Team (optional)

const SOCKET = process.env.DEVDASH_AGENT_SOCKET
const context = { sessionId: process.env.DEVDASH_SESSION_ID ?? null, cwd: process.cwd() }

const status = { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] }
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }
const project = { type: 'string', description: "Project short name (e.g. 'shop'). Omit to use this session's project." }
const number = { type: 'integer', description: 'Task number within the project (shop#12 → 12).' }
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const TOOLS = [
  { name: 'project_info', description: "This session's DevDash project: name, repository, default branch, folder, open task count. Also lists every project.", inputSchema: obj({ project }) },
  { name: 'tasks_list', description: 'Tasks in a project (open ones, plus recently done). Filter by status or "mine" (assigned to the person you work for).', inputSchema: obj({ project, status, mine: { type: 'boolean' } }) },
  { name: 'task_get', description: 'One task with its details, comments and linked commits and sessions.', inputSchema: obj({ project, number }, ['number']) },
  { name: 'task_create', description: 'Create a task in the project.', inputSchema: obj({ project, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' }, status, priority, due: { type: 'string', description: 'YYYY-MM-DD' } }, ['title']) },
  { name: 'task_update', description: 'Change a task: status, priority, due date, title, body, or assign it to yourself (assign_to_me). Move it to in_progress when you start and review when your work is ready.', inputSchema: obj({ project, number, status, priority, due: { type: ['string', 'null'] }, title: { type: 'string' }, body: { type: 'string' }, assign_to_me: { type: 'boolean' } }, ['number']) },
  { name: 'task_comment', description: 'Comment on a task (markdown), e.g. a summary of what you did.', inputSchema: obj({ project, number, body: { type: 'string' } }, ['number', 'body']) },
  { name: 'notes_list', description: 'Team notes (decisions, setup steps, links), optionally only one project\'s.', inputSchema: obj({ project, all_projects: { type: 'boolean', description: 'Every note, not only this project\'s.' } }) },
  { name: 'note_get', description: 'Read one note.', inputSchema: obj({ id: { type: 'integer' } }, ['id']) },
  { name: 'note_upsert', description: 'Create a note (no id) or update one (with id). Notes are visible to the whole team.', inputSchema: obj({ id: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' }, project, pinned: { type: 'boolean' } }) },
  { name: 'services_list', description: 'Every long-running service on this server (everyone\'s), with ports and state. Start new ones with `devdash service add` in Bash.', inputSchema: obj({}) },
  { name: 'review_card_update', description: 'After you merge a dd/* branch into the default branch (or abandon it), close its "Ready to review" card so the founder doesn\'t see a card for work that already landed: status "merged" (pass merged_commit when you have it) or "dismissed" (give a short reason). Call this in the same step you merge a dd/* branch.', inputSchema: obj({ branch: { type: 'string', description: 'The dd/* branch of the card.' }, status: { type: 'string', enum: ['merged', 'dismissed'] }, reason: { type: 'string', description: 'For "dismissed": why, in a few words.' }, merged_commit: { type: 'string', description: 'The merge commit sha, if you have it.' } }, ['branch', 'status']) },
]

function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('DevDash is not available in this session (no DEVDASH_AGENT_SOCKET).'))
    const sock = connect(SOCKET)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'rpc', method, params }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      sock.end()
      const m = JSON.parse(buf.slice(0, i))
      if (m.error) reject(new Error(m.error))
      else resolve(m.result)
    })
    sock.on('error', () => reject(new Error('Could not reach DevDash on this server.')))
  })
}

// Updating DevDash itself: only in sessions of DevDash's own project (its GitHub repository), asked once at start.
const DEPLOY_TOOLS = [
  { name: 'devdash_deploy_status', description: "This DevDash server's own version: the live commit, commits on GitHub main not deployed yet, a deploy running or how the last one went (with its output if it failed), and requests waiting for an admin.", inputSchema: obj({}) },
  { name: 'devdash_deploy_request', description: "Ask the admins to deploy DevDash on this server: the newest commit on GitHub main, or `commit`. Push to main first; only commits on main can be deployed. An admin approves with one tap on the Server page, then the server builds, restarts and health-checks itself (rolling back if unhealthy). Ask only when the person wants it live. You can't deploy any other way: there is no sudo or root SSH.", inputSchema: obj({ commit: { type: 'string', description: 'A commit id on main. Omit for the newest.' }, note: { type: 'string', description: 'What it brings, in a line or two, for the admin who approves.' } }) },
]
const deployTools = () => call('mcp.devdash_here', { ...context, args: {} }).then((r) => (r?.here ? DEPLOY_TOOLS : []), () => [])

// Your own tailnet: devices on the Tailscale account you connected on the Network page, and
// their live online status. Scoped to you; listed in your own sessions, not team roles'.
const NET_TOOLS = [
  { name: 'net_devices', description: 'Devices on your own tailnet (the Tailscale account you connected on the Network page) with live online status, OS and tailnet IP. Check this before you try to reach one.', inputSchema: obj({}) },
  { name: 'net_check', description: 'Status of one device on your tailnet by name, host or tailnet IP: online or offline, its IP, and when it was last seen.', inputSchema: obj({ device: { type: 'string', description: 'Device name, hostname or tailnet IP.' } }, ['device']) },
]
const netTools = () => call('mcp.net_here', { ...context, args: {} }).then((r) => (r?.available ? NET_TOOLS : []), () => [])

// Hosting: the bundled Dokploy engine beside agOS (127.0.0.1:3010). Create, edit, configure domains, inspect logs, and deploy.
const kind = { type: 'string', enum: ['application', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'], description: 'From hosting_list. Default application.' }
const buildTypeEnum = { type: 'string', enum: ['nixpacks', 'dockerfile', 'railpack', 'heroku_buildpacks', 'paketo_buildpacks', 'static'] }
const HOSTING_TOOLS = [
  { name: 'hosting_status', description: 'Whether the bundled Dokploy hosting engine (127.0.0.1:3010) is reachable, its base domain for hosted apps, and its dashboard URL.', inputSchema: obj({}) },
  { name: 'hosting_list', description: 'Every app, compose stack, and managed database (postgres, mysql, mariadb, mongo, redis) hosted on this server with project, status, and URL.', inputSchema: obj({}) },
  { name: 'hosting_get', description: 'One hosted app, compose stack, or database: source, repository/branch, build type, docker image, compose file, env, domains (public URLs) and recent deployments with their status.', inputSchema: obj({ kind, id: { type: 'string' } }, ['id']) },
  { name: 'hosting_logs', description: 'Build/deploy log of one deployment (from hosting_get). Read it when a deployment failed or to verify startup.', inputSchema: obj({ deployment_id: { type: 'string' } }, ['deployment_id']) },
  { name: 'hosting_create', description: 'Create and deploy a new hosted app in the bundled Dokploy engine: a git repository (git_url), a Docker image (docker_image) or a docker-compose stack (compose_file, full YAML). Automatically configures a public domain route and triggers deployment unless deploy=false.', inputSchema: obj({ name: { type: 'string', description: 'lowercase-with-dashes' }, project: { type: 'string', description: 'Hosting project to group it in. Default agOS.' }, git_url: { type: 'string' }, branch: { type: 'string' }, build_path: { type: 'string' }, build_type: buildTypeEnum, dockerfile: { type: 'string' }, docker_image: { type: 'string' }, compose_file: { type: 'string' }, port: { type: 'integer', description: 'Port the app listens on inside its container. Default 3000.' }, env: { type: 'string', description: 'KEY=value lines.' }, domain: { type: 'string' }, deploy: { type: 'boolean' } }, ['name']) },
  { name: 'hosting_db_create', description: 'Create and deploy a managed database in the bundled Dokploy engine (postgres, mysql, mariadb, mongo, or redis).', inputSchema: obj({ db_type: { type: 'string', enum: ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'] }, name: { type: 'string', description: 'lowercase-with-dashes' }, project: { type: 'string' }, database_name: { type: 'string' }, database_user: { type: 'string' }, database_password: { type: 'string' }, docker_image: { type: 'string' }, external_port: { type: 'integer' }, deploy: { type: 'boolean' } }, ['db_type', 'name']) },
  { name: 'hosting_update', description: 'Edit an existing hosted app or compose stack in Dokploy: update its git_url, branch, build_path, build_type, dockerfile, docker_image, compose_file, env (KEY=value lines), command, memory_limit, cpu_limit, or name. Pass redeploy=true to immediately redeploy with the updated configuration.', inputSchema: obj({ kind, id: { type: 'string' }, name: { type: 'string' }, git_url: { type: 'string' }, branch: { type: 'string' }, build_path: { type: 'string' }, build_type: buildTypeEnum, dockerfile: { type: 'string' }, docker_image: { type: 'string' }, compose_file: { type: 'string' }, env: { type: 'string', description: 'Full KEY=value lines.' }, command: { type: 'string' }, memory_limit: { type: 'string' }, cpu_limit: { type: 'string' }, redeploy: { type: 'boolean', description: 'Set true to redeploy right after saving.' } }, ['id']) },
  { name: 'hosting_domain_add', description: 'Add a public domain route (Traefik) to a hosted application or compose stack.', inputSchema: obj({ kind, id: { type: 'string' }, host: { type: 'string', description: 'Domain hostname, e.g. app.example.com' }, port: { type: 'integer', description: 'Container port. Default 3000.' }, https: { type: 'boolean' }, path: { type: 'string' }, service_name: { type: 'string', description: 'For compose stacks: target compose service name.' } }, ['id', 'host']) },
  { name: 'hosting_domain_remove', description: 'Remove a domain route by its domain_id (from hosting_get).', inputSchema: obj({ domain_id: { type: 'string' } }, ['domain_id']) },
  { name: 'hosting_action', description: 'deploy, redeploy, stop, start or delete a hosted app, compose stack, or database (delete: admins only, ask first).', inputSchema: obj({ kind, id: { type: 'string' }, action: { type: 'string', enum: ['deploy', 'redeploy', 'stop', 'start', 'delete'] } }, ['id', 'action']) },
  { name: 'hosting_dokploy_api', description: 'Call ANY procedure on the bundled Dokploy API (/api/<router>.<procedure>) directly — e.g. docker.getContainers, certificates.all, backup.create, schedule.create, mounts.create, ports.create, redirects.create, security.create, swarm.getNodes, settings.readTraefikConfig, etc.', inputSchema: obj({ procedure: { type: 'string', description: '<router>.<procedure>, e.g. docker.getContainers' }, input: { type: 'object', additionalProperties: true }, method: { type: 'string', enum: ['GET', 'POST'] } }, ['procedure']) },
  { name: 'hosting_monitor', description: 'Live server & container monitoring snapshot: real-time CPU %, load average, RAM & swap usage, disk space, network RX/TX throughput, rolling history, running Docker container stats, and bundled Dokploy status.', inputSchema: obj({}) },
]

// Real-Time Shared Browser Control (CDP :9222 on devdash-browser).
const BROWSER_TOOLS = [
  { name: 'browser_status', description: 'Status of the shared browser on the server: whether it is running, whether real-time CDP control is connected, open tabs, current URL/title, and recent AI actions.', inputSchema: obj({}) },
  { name: 'browser_navigate', description: 'Navigate the live shared browser to a URL in real time while team members watch.', inputSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'browser_snapshot', description: 'Read the active tab in the shared browser: returns URL, title, visible page text, and interactive elements (links, buttons, inputs) with their selectors.', inputSchema: obj({}) },
  { name: 'browser_click', description: 'Click an element in the live shared browser by CSS selector or visible button/link text.', inputSchema: obj({ selector: { type: 'string', description: 'CSS selector or visible text of the button/link.' } }, ['selector']) },
  { name: 'browser_type', description: 'Type text into an input or textarea in the live shared browser (by CSS selector, placeholder, name, or aria-label), optionally submitting the form / pressing Enter.', inputSchema: obj({ selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['selector', 'text']) },
  { name: 'browser_press', description: 'Press a keyboard key in the live shared browser (e.g. Enter, Escape, Tab, ArrowDown).', inputSchema: obj({ key: { type: 'string' } }, ['key']) },
  { name: 'browser_screenshot', description: 'Capture a live PNG screenshot (base64) of the shared browser viewport.', inputSchema: obj({}) },
  { name: 'browser_eval', description: 'Evaluate a JavaScript expression in the active tab of the shared browser and return its result.', inputSchema: obj({ expression: { type: 'string' } }, ['expression']) },
]

let listed
const tools = () => (listed ??= Promise.all([teamTools(call, context), deployTools(), netTools()]).then(([team, deploy, net]) => [...TOOLS, ...HOSTING_TOOLS, ...BROWSER_TOOLS, ...deploy, ...net, ...team]))

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function handle(m) {
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'devdash', version: '0.2.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: await tools() }
    case 'tools/call': {
      const name = m.params?.name
      if (!(await tools()).some((t) => t.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 })
      try {
        const result = await call(`mcp.${name}`, { ...context, args: m.params?.arguments ?? {} })
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 })
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pending = 0
let closed = false
const maybeExit = () => { if (closed && !pending) process.exit(0) }
rl.on('line', async (line) => {
  if (!line.trim()) return
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (m.id === undefined || m.id === null) return // a notification (e.g. notifications/initialized): no reply
  pending++
  try {
    send({ jsonrpc: '2.0', id: m.id, result: await handle(m) })
  } catch (err) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: err.code ?? -32603, message: err.message } })
  } finally {
    pending--
    maybeExit()
  }
})
// Claude closes stdin to stop the server: answer what's in flight first.
rl.on('close', () => { closed = true; maybeExit() })
