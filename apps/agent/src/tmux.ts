import { execFile } from 'node:child_process'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pty from 'node-pty'

export const TMUX_CONF = fileURLToPath(new URL('../../../deploy/tmux.conf', import.meta.url))
// A dedicated tmux server, so SSH users can join the same terminals: tmux -L devdash attach -t t-main
const TMUX = ['-L', 'devdash', '-f', TMUX_CONF]
const run = promisify(execFile)
// Services get their own tmux server (apps/agent/src/services.ts), apart from terminals.
const SVC = ['-L', 'devdash-svc', '-f', TMUX_CONF]
// The member's userspace tailscaled runs in its own tmux server too (apps/agent/src/tailscale.ts), so it outlives agent restarts.
const TS = ['-L', 'devdash-ts', '-f', TMUX_CONF]
export const clamp = (n: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(n)) || min))

// As much as the browser terminal keeps (TerminalView scrollback), so a session scrolls back to its start.
const HISTORY_LINES = 10_000
const MAX_BUFFER_CHARS = 256_000

/**
 * Detect whether native `tmux` is available on the host. On Windows (or Linux/macOS without tmux installed),
 * DevDash transparently falls back to an in-process `node-pty` session multiplexer so Terminals, CLI sessions,
 * and background Services work identically everywhere.
 */
let tmuxCheck: Promise<boolean> | null = null
function hasNativeTmux(): Promise<boolean> {
  if (process.platform === 'win32') return Promise.resolve(false)
  if (!tmuxCheck) {
    tmuxCheck = run('tmux', ['-V'], { timeout: 3000 }).then(() => true, () => false)
  }
  return tmuxCheck
}

type PtySession = {
  name: string
  server: string
  created: number
  activity: number
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  remainOnExit: boolean
  dead: boolean
  exitCode: number | null
  buffer: string
  term: pty.IPty | null
  listeners: Set<(data: string) => void>
  exitListeners: Set<() => void>
}

const ptyServers = new Map<string, Map<string, PtySession>>()
function getPtyMap(server: string): Map<string, PtySession> {
  let m = ptyServers.get(server)
  if (!m) {
    m = new Map()
    ptyServers.set(server, m)
  }
  return m
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || 'bash', args: ['-l'] }
}

function resolveCommandForOs(cmdArgs: string[]): { file: string; args: string[] } {
  if (!cmdArgs.length) return defaultShell()
  if (cmdArgs[0] === 'sleep' && cmdArgs[1] === '30') {
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: ['-NoLogo', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'] }
    }
    return { file: 'sleep', args: ['30'] }
  }
  if (process.platform === 'win32') {
    if (cmdArgs[0] === 'bash' && cmdArgs[1] === '-lc' && cmdArgs[2]) {
      const script = cmdArgs[2]
      return { file: 'powershell.exe', args: ['-NoLogo', '-Command', translateBashScriptForWin(script)] }
    }
    if (cmdArgs[0] === 'sudo' && cmdArgs[1] === '-i') {
      return { file: 'powershell.exe', args: ['-NoLogo'] }
    }
    const bin = cmdArgs[0]!
    if (bin.endsWith('.js') || bin.endsWith('.mjs') || bin.endsWith('.cjs')) {
      return { file: process.execPath, args: [bin, ...cmdArgs.slice(1)] }
    }
    return { file: 'powershell.exe', args: ['-NoLogo', '-Command', `& ${cmdArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ')}`] }
  }
  const bin = cmdArgs[0]!
  if (bin.endsWith('.js') || bin.endsWith('.mjs') || bin.endsWith('.cjs')) {
    return { file: process.execPath, args: [bin, ...cmdArgs.slice(1)] }
  }
  return { file: bin, args: cmdArgs.slice(1) }
}

function translateBashScriptForWin(script: string): string {
  // Handle common bash -lc launch patterns cleanly in PowerShell
  const execMatch = script.match(/exec\s+"([^"]+)"(.*)$/)
  if (execMatch) {
    const bin = execMatch[1]!
    const rest = execMatch[2]!.trim()
    if (bin.endsWith('.js') || bin.endsWith('.mjs')) {
      return `& '${process.execPath}' '${bin}' ${rest}`
    }
    return `& '${bin}' ${rest}`
  }
  for (const cli of ['opencode', 'openrouter', 'codex', 'agy', 'antigravity', 'gemini', 'grok']) {
    if (script.includes(`exec ${cli}`) || script.includes(`command -v ${cli}`)) {
      return `if (Get-Command ${cli} -ErrorAction SilentlyContinue) { ${cli} } else { Write-Host "${cli} CLI terminal ready. Install or run '${cli}' here." }`
    }
  }
  return script
}

function spawnIntoPtySession(s: PtySession, cmdArgs: string[]) {
  if (s.term) {
    try { s.term.kill() } catch { /* ignore */ }
    s.term = null
  }
  s.dead = false
  s.exitCode = null
  const { file, args } = resolveCommandForOs(cmdArgs)
  try {
    const term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd,
      env: { ...process.env, ...s.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    s.term = term
    term.onData((d) => {
      s.activity = Math.floor(Date.now() / 1000)
      s.buffer += d
      if (s.buffer.length > MAX_BUFFER_CHARS) s.buffer = s.buffer.slice(-MAX_BUFFER_CHARS)
      for (const fn of s.listeners) fn(d)
    })
    term.onExit(({ exitCode }) => {
      s.dead = true
      s.exitCode = exitCode ?? 0
      s.term = null
      if (!s.remainOnExit) {
        getPtyMap(s.server).delete(s.name)
        for (const fn of s.exitListeners) fn()
      }
    })
  } catch (err) {
    s.dead = true
    s.exitCode = 1
    const msg = `\r\n[Failed to launch process: ${(err as Error).message}]\r\n`
    s.buffer += msg
    for (const fn of s.listeners) fn(msg)
  }
}

function cleanTarget(raw: string): string {
  return raw.replace(/^=/, '').replace(/:$/, '')
}

function splitTmuxChain(args: string[]): string[][] {
  const groups: string[][] = []
  let cur: string[] = []
  for (const a of args) {
    if (a === ';') {
      if (cur.length) groups.push(cur)
      cur = []
    } else {
      cur.push(a)
    }
  }
  if (cur.length) groups.push(cur)
  return groups
}

function parseSpawnFlags(args: string[], startIndex: number) {
  let cwd = homedir()
  let cols = 100
  let rows = 30
  let name = ''
  let target = ''
  const env: Record<string, string> = {}
  let i = startIndex
  while (i < args.length) {
    const a = args[i]!
    if (a === '-d' || a === '-k') {
      i++
    } else if (a === '-s' && args[i + 1]) {
      name = args[i + 1]!
      i += 2
    } else if (a === '-t' && args[i + 1]) {
      target = cleanTarget(args[i + 1]!)
      i += 2
    } else if (a === '-c' && args[i + 1]) {
      cwd = args[i + 1]!
      i += 2
    } else if (a === '-x' && args[i + 1]) {
      cols = clamp(args[i + 1], 10, 500)
      i += 2
    } else if (a === '-y' && args[i + 1]) {
      rows = clamp(args[i + 1], 4, 200)
      i += 2
    } else if (a === '-e' && args[i + 1]) {
      const kv = args[i + 1]!
      const eq = kv.indexOf('=')
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
      i += 2
    } else {
      break
    }
  }
  return { name, target, cwd, cols, rows, env, cmdArgs: args.slice(i) }
}

async function fallbackTmux(server: string, rawArgs: string[]): Promise<{ stdout: string; stderr: string }> {
  const map = getPtyMap(server)
  const commands = splitTmuxChain(rawArgs)
  let stdout = ''

  for (const args of commands) {
    const sub = args[0]
    if (!sub || sub === 'source-file' || sub === 'set-environment') continue

    if (sub === 'has-session') {
      const tIdx = args.indexOf('-t')
      const name = tIdx >= 0 && args[tIdx + 1] ? cleanTarget(args[tIdx + 1]!) : ''
      const s = map.get(name)
      if (!s || (s.dead && !s.remainOnExit)) throw new Error(`can't find session: ${name}`)
      continue
    }

    if (sub === 'list-sessions') {
      const lines: string[] = []
      for (const s of map.values()) {
        if (s.dead && !s.remainOnExit) continue
        lines.push(`${s.name}\t${s.created}\t${s.listeners.size > 0 ? 1 : 0}\t${s.activity}`)
      }
      stdout = lines.join('\n') + (lines.length ? '\n' : '')
      continue
    }

    if (sub === 'list-panes') {
      const lines: string[] = []
      for (const s of map.values()) {
        lines.push(`${s.name}\t${s.dead ? '1' : '0'}\t${s.exitCode ?? ''}`)
      }
      stdout = lines.join('\n') + (lines.length ? '\n' : '')
      continue
    }

    if (sub === 'new-session') {
      const parsed = parseSpawnFlags(args, 1)
      if (!parsed.name) throw new Error('missing session name')
      if (map.has(parsed.name)) throw new Error(`duplicate session: ${parsed.name}`)
      const now = Math.floor(Date.now() / 1000)
      const s: PtySession = {
        name: parsed.name,
        server,
        created: now,
        activity: now,
        cols: parsed.cols,
        rows: parsed.rows,
        cwd: parsed.cwd,
        env: parsed.env,
        remainOnExit: false,
        dead: false,
        exitCode: null,
        buffer: '',
        term: null,
        listeners: new Set(),
        exitListeners: new Set(),
      }
      map.set(parsed.name, s)
      spawnIntoPtySession(s, parsed.cmdArgs)
      continue
    }

    if (sub === 'set-option') {
      const tIdx = args.indexOf('-t')
      const name = tIdx >= 0 && args[tIdx + 1] ? cleanTarget(args[tIdx + 1]!) : ''
      const s = map.get(name)
      if (s && args.includes('remain-on-exit')) {
        s.remainOnExit = args[args.indexOf('remain-on-exit') + 1] === 'on'
      }
      continue
    }

    if (sub === 'respawn-pane') {
      const parsed = parseSpawnFlags(args, 1)
      const s = map.get(parsed.target)
      if (!s) throw new Error(`can't find session: ${parsed.target}`)
      s.cwd = parsed.cwd || s.cwd
      s.env = { ...s.env, ...parsed.env }
      s.buffer = ''
      spawnIntoPtySession(s, parsed.cmdArgs)
      continue
    }

    if (sub === 'send-keys') {
      const tIdx = args.indexOf('-t')
      const name = tIdx >= 0 && args[tIdx + 1] ? cleanTarget(args[tIdx + 1]!) : ''
      const s = map.get(name)
      if (s?.term) {
        const keys = args.slice(tIdx >= 0 ? tIdx + 2 : 1)
        for (const k of keys) {
          if (k === 'C-c') s.term.write('\x03')
          else if (k === 'Escape') s.term.write('\x1b')
          else if (k === 'Enter') s.term.write('\r')
          else s.term.write(k)
        }
      }
      continue
    }

    if (sub === 'kill-session') {
      const tIdx = args.indexOf('-t')
      const name = tIdx >= 0 && args[tIdx + 1] ? cleanTarget(args[tIdx + 1]!) : ''
      const s = map.get(name)
      if (s) {
        s.remainOnExit = false
        map.delete(name)
        if (s.term) {
          try { s.term.kill() } catch { /* ignore */ }
          s.term = null
        }
        for (const fn of s.exitListeners) fn()
      }
      continue
    }

    if (sub === 'capture-pane') {
      const tIdx = args.indexOf('-t')
      const name = tIdx >= 0 && args[tIdx + 1] ? cleanTarget(args[tIdx + 1]!) : ''
      const s = map.get(name)
      if (s) {
        const lines = s.buffer.replace(/\r\n/g, '\n').split('\n')
        stdout = lines.slice(-HISTORY_LINES).join('\n')
      }
      continue
    }
  }

  return { stdout, stderr: '' }
}

export const tmux = async (...args: string[]) =>
  (await hasNativeTmux()) ? run('tmux', [...TMUX, ...args]) : fallbackTmux('devdash', args)

export const svcTmux = async (...args: string[]) =>
  (await hasNativeTmux()) ? run('tmux', [...SVC, ...args]) : fallbackTmux('devdash-svc', args)

export const tsTmux = async (...args: string[]) =>
  (await hasNativeTmux()) ? run('tmux', [...TS, ...args]) : fallbackTmux('devdash-ts', args)

export async function hasSession(name: string) {
  try {
    await tmux('has-session', '-t', `=${name}`)
    return true
  } catch {
    return false
  }
}

export async function listSessions() {
  try {
    const { stdout } = await tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}')
    return stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [name, created, attached, activity] = l.split('\t')
      return { name: name!, created: Number(created), attached: Number(attached), activity: Number(activity) }
    })
  } catch {
    return [] // no tmux server yet
  }
}

export function send(conn: Socket, msg: object) {
  return conn.write(JSON.stringify(msg) + '\n')
}

/**
 * Streams one tmux session to one connection as JSON lines: {d} data both ways, {r:[cols,rows]} resize from the client.
 * Read-only attaches (shared views) ignore input. Closing the connection only detaches; the session keeps running.
 */
export async function attachPty(conn: Socket, lines: AsyncIterator<string>, name: string, o: { cols: number; rows: number; readonly?: boolean; onInput?: () => void; services?: boolean }) {
  const cols = clamp(o.cols, 10, 500)
  const rows = clamp(o.rows, 4, 200)

  if (!(await hasNativeTmux())) {
    const server = o.services ? 'devdash-svc' : 'devdash'
    const s = getPtyMap(server).get(cleanTarget(name))
    if (!s) {
      conn.end()
      return
    }
    if (!o.readonly && s.term) {
      try { s.term.resize(cols, rows) } catch { /* ignore */ }
    }
    if (s.buffer) {
      send(conn, { d: s.buffer })
    }
    const onData = (d: string) => {
      send(conn, { d })
    }
    const onExit = () => conn.end()
    s.listeners.add(onData)
    s.exitListeners.add(onExit)
    conn.on('close', () => {
      s.listeners.delete(onData)
      s.exitListeners.delete(onExit)
    })

    for (let r = await lines.next(); !r.done; r = await lines.next()) {
      let m: { d?: unknown; r?: unknown }
      try {
        m = JSON.parse(r.value)
      } catch {
        continue
      }
      if (typeof m.d === 'string' && !o.readonly && s.term) {
        o.onInput?.()
        s.activity = Math.floor(Date.now() / 1000)
        s.term.write(m.d)
      } else if (Array.isArray(m.r) && !o.readonly && s.term) {
        s.cols = clamp(m.r[0], 10, 500)
        s.rows = clamp(m.r[1], 4, 200)
        try { s.term.resize(s.cols, s.rows) } catch { /* ignore */ }
      }
    }
    return
  }

  const base = o.services ? SVC : TMUX
  // Older output first, so the browser's own scrollback has it; attaching then draws the visible screen below.
  try {
    const { stdout } = await run('tmux', [...base, 'capture-pane', '-p', '-e', '-J', '-S', `-${HISTORY_LINES}`, '-E', '-1', '-t', `=${name}`])
    if (stdout.trim()) send(conn, { d: stdout.replace(/\n/g, '\r\n') })
  } catch {
    // no history yet
  }
  const term = pty.spawn('tmux', [...base, 'attach-session', ...(o.readonly ? ['-r'] : []), '-t', `=${name}`], {
    name: 'xterm-256color', cols, rows, cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  term.onData((d) => {
    if (!send(conn, { d })) {
      term.pause()
      conn.once('drain', () => term.resume())
    }
  })
  term.onExit(() => conn.end())
  conn.on('close', () => term.kill())

  for (let r = await lines.next(); !r.done; r = await lines.next()) {
    let m: { d?: unknown; r?: unknown }
    try {
      m = JSON.parse(r.value)
    } catch {
      continue
    }
    if (typeof m.d === 'string' && !o.readonly) {
      o.onInput?.()
      term.write(m.d)
    } else if (Array.isArray(m.r)) {
      term.resize(clamp(m.r[0], 10, 500), clamp(m.r[1], 4, 200))
    }
  }
}
