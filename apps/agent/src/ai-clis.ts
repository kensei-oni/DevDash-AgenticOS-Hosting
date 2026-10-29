import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CLAUDE_BIN } from './sdk.ts'

const run = promisify(execFile)
const PLUGIN_MCP = fileURLToPath(new URL('../../../packages/claude-plugin/mcp/devdash.mjs', import.meta.url))

export type CliId = 'claude' | 'opencode' | 'openrouter' | 'codex' | 'antigravity' | 'grok'

export type CliConfigStore = {
  OPENROUTER_API_KEY?: string
  OPENAI_API_KEY?: string
  XAI_API_KEY?: string
  GEMINI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OPENROUTER_MODEL?: string
}

export type CliStatus = {
  id: CliId
  name: string
  binary: string
  installed: boolean
  version: string | null
  keyName: keyof CliConfigStore | null
  keyConfigured: boolean
  mcpWired: boolean
  terminalTab: string
  installHint: string
  description: string
}

const configPath = () => join(homedir(), '.config', 'devdash', 'ai-clis.json')

export function readCliConfig(): CliConfigStore {
  try {
    const p = configPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8')) as CliConfigStore
  } catch {
    return {}
  }
}

export function writeCliConfig(patch: Partial<CliConfigStore>): CliConfigStore {
  const dir = join(homedir(), '.config', 'devdash')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const current = readCliConfig()
  const next: CliConfigStore = { ...current }
  for (const [k, v] of Object.entries(patch) as [keyof CliConfigStore, string | undefined][]) {
    if (v === undefined) continue
    if (v.trim()) next[k] = v.trim()
    else delete next[k]
  }
  writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 })
  wireMcpConfigs()
  return next
}

/** Environment variables injected into AI CLI sessions & terminals so all configured keys and MCP sockets are present. */
export function cliEnv(extraProfile?: string): Record<string, string> {
  const c = readCliConfig()
  const env: Record<string, string> = {}
  if (c.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = c.OPENROUTER_API_KEY
  if (c.OPENAI_API_KEY) env.OPENAI_API_KEY = c.OPENAI_API_KEY
  if (c.XAI_API_KEY) {
    env.XAI_API_KEY = c.XAI_API_KEY
    env.GROK_API_KEY = c.XAI_API_KEY
  }
  if (c.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = c.GEMINI_API_KEY
    env.GOOGLE_API_KEY = c.GEMINI_API_KEY
  }
  if (c.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = c.ANTHROPIC_API_KEY
  if (extraProfile === 'openrouter' && c.OPENROUTER_API_KEY) {
    env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'
    env.ANTHROPIC_AUTH_TOKEN = c.OPENROUTER_API_KEY
    if (c.OPENROUTER_MODEL) env.ANTHROPIC_MODEL = c.OPENROUTER_MODEL
  }
  return env
}

/** Auto-wires the agOS/DevDash MCP server (hosting_*, browser_*, tasks_*, notes_*) into OpenCode, Codex, Antigravity, and Grok. */
export function wireMcpConfigs() {
  const sock = process.env.DEVDASH_AGENT_SOCKET || `/run/devdash/agent-${process.env.USER || 'local'}.sock`
  // 1. OpenCode (~/.config/opencode/opencode.json)
  try {
    const ocDir = join(homedir(), '.config', 'opencode')
    mkdirSync(ocDir, { recursive: true })
    const ocFile = join(ocDir, 'opencode.json')
    const existing = existsSync(ocFile) ? (JSON.parse(readFileSync(ocFile, 'utf8')) as Record<string, unknown>) : {}
    const mcp = (existing.mcp ?? {}) as Record<string, unknown>
    mcp.devdash = {
      type: 'local',
      command: ['node', PLUGIN_MCP],
      environment: { DEVDASH_AGENT_SOCKET: sock },
      enabled: true,
    }
    writeFileSync(ocFile, JSON.stringify({ ...existing, mcp }, null, 2))
  } catch { /* ignore */ }

  // 2. Grok CLI (~/.grok/mcp-config.json)
  try {
    const grokDir = join(homedir(), '.grok')
    mkdirSync(grokDir, { recursive: true })
    const grokFile = join(grokDir, 'mcp-config.json')
    const existing = existsSync(grokFile) ? (JSON.parse(readFileSync(grokFile, 'utf8')) as Record<string, unknown>) : {}
    const mcpServers = (existing.mcpServers ?? {}) as Record<string, unknown>
    mcpServers.devdash = {
      command: 'node',
      args: [PLUGIN_MCP],
      env: { DEVDASH_AGENT_SOCKET: sock },
    }
    writeFileSync(grokFile, JSON.stringify({ ...existing, mcpServers }, null, 2))
  } catch { /* ignore */ }
}

async function detectBin(candidates: string[], args = ['--version']): Promise<{ bin: string; installed: boolean; version: string | null }> {
  for (const bin of candidates) {
    try {
      const { stdout, stderr } = await run(bin, args, { timeout: 4000 })
      const out = (stdout || stderr || '').trim().split('\n')[0]?.slice(0, 80) || 'installed'
      return { bin, installed: true, version: out }
    } catch { /* try next */ }
  }
  return { bin: candidates[0]!, installed: false, version: null }
}

export async function listCliStatuses(): Promise<{ clis: CliStatus[]; config: Record<string, boolean | string | null> }> {
  wireMcpConfigs()
  const cfg = readCliConfig()
  const [claudeInfo, opencodeInfo, openrouterInfo, codexInfo, agyInfo, grokInfo] = await Promise.all([
    detectBin([CLAUDE_BIN, 'claude']),
    detectBin(['opencode']),
    detectBin(['openrouter', CLAUDE_BIN, 'claude']),
    detectBin(['codex']),
    detectBin(['agy', 'antigravity']),
    detectBin(['grok']),
  ])

  const clis: CliStatus[] = [
    {
      id: 'claude',
      name: 'Claude Code CLI',
      binary: claudeInfo.bin,
      installed: claudeInfo.installed,
      version: claudeInfo.version,
      keyName: 'ANTHROPIC_API_KEY',
      keyConfigured: Boolean(cfg.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || claudeInfo.installed),
      mcpWired: true,
      terminalTab: 'cli-claude',
      installHint: 'curl -fsSL https://claude.ai/install.sh | bash',
      description: 'Anthropic Claude Code CLI & Agent SDK with full agOS Hosting, Monitor & Live Browser MCP tools.',
    },
    {
      id: 'opencode',
      name: 'OpenCode CLI',
      binary: opencodeInfo.bin,
      installed: opencodeInfo.installed,
      version: opencodeInfo.version,
      keyName: 'OPENROUTER_API_KEY',
      keyConfigured: Boolean(cfg.OPENROUTER_API_KEY || cfg.ANTHROPIC_API_KEY || cfg.OPENAI_API_KEY),
      mcpWired: true,
      terminalTab: 'cli-opencode',
      installHint: 'npm install -g opencode-ai',
      description: 'OpenCode terminal coding agent pre-wired with the agOS Hosting & Browser MCP server.',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter CLI',
      binary: openrouterInfo.bin,
      installed: openrouterInfo.installed,
      version: cfg.OPENROUTER_MODEL ? `Model: ${cfg.OPENROUTER_MODEL}` : openrouterInfo.version,
      keyName: 'OPENROUTER_API_KEY',
      keyConfigured: Boolean(cfg.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY),
      mcpWired: true,
      terminalTab: 'cli-openrouter',
      installHint: 'Uses OPENROUTER_API_KEY with Claude Code / OpenCode / openrouter-cli',
      description: 'Run any OpenRouter model (Claude, GPT-4.1, Grok, DeepSeek, Gemini) with full agOS MCP tools.',
    },
    {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      binary: codexInfo.bin,
      installed: codexInfo.installed,
      version: codexInfo.version,
      keyName: 'OPENAI_API_KEY',
      keyConfigured: Boolean(cfg.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
      mcpWired: true,
      terminalTab: 'cli-codex',
      installHint: 'npm install -g @openai/codex',
      description: 'OpenAI Codex terminal agent connected to your server workspace and agOS CLI.',
    },
    {
      id: 'antigravity',
      name: 'Antigravity CLI (agy)',
      binary: agyInfo.bin,
      installed: agyInfo.installed,
      version: agyInfo.version,
      keyName: 'GEMINI_API_KEY',
      keyConfigured: Boolean(cfg.GEMINI_API_KEY || process.env.GEMINI_API_KEY || agyInfo.installed),
      mcpWired: true,
      terminalTab: 'cli-antigravity',
      installHint: 'npm install -g @google/gemini-cli',
      description: 'Google Antigravity (agy) agentic coding CLI integrated with agOS Hosting & Browser tools.',
    },
    {
      id: 'grok',
      name: 'Grok CLI (xAI)',
      binary: grokInfo.bin,
      installed: grokInfo.installed,
      version: grokInfo.version,
      keyName: 'XAI_API_KEY',
      keyConfigured: Boolean(cfg.XAI_API_KEY || process.env.XAI_API_KEY),
      mcpWired: true,
      terminalTab: 'cli-grok',
      installHint: 'npm install -g @vibe-kit/grok-cli',
      description: 'xAI Grok terminal coding agent pre-configured with ~/.grok/mcp-config.json for agOS.',
    },
  ]

  return {
    clis,
    config: {
      OPENROUTER_API_KEY: Boolean(cfg.OPENROUTER_API_KEY),
      OPENAI_API_KEY: Boolean(cfg.OPENAI_API_KEY),
      XAI_API_KEY: Boolean(cfg.XAI_API_KEY),
      GEMINI_API_KEY: Boolean(cfg.GEMINI_API_KEY),
      ANTHROPIC_API_KEY: Boolean(cfg.ANTHROPIC_API_KEY),
      OPENROUTER_MODEL: cfg.OPENROUTER_MODEL ?? null,
    },
  }
}

export async function installCli(id: CliId): Promise<{ ok: boolean; output: string }> {
  const pkgMap: Record<CliId, string | null> = {
    claude: '@anthropic-ai/claude-code',
    opencode: 'opencode-ai',
    openrouter: 'openrouter-cli',
    codex: '@openai/codex',
    antigravity: '@google/gemini-cli',
    grok: '@vibe-kit/grok-cli',
  }
  const pkg = pkgMap[id]
  if (!pkg) throw new Error(`Unknown CLI: ${id}`)
  const prefix = join(homedir(), '.local')
  mkdirSync(prefix, { recursive: true })
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const { stdout, stderr } = await run(npmBin, ['install', '-g', '--prefix', prefix, pkg], { timeout: 180_000 })
  wireMcpConfigs()
  return { ok: true, output: (stdout + '\n' + stderr).trim().slice(-2000) }
}

/** Command & environment to launch one of the 6 AI CLIs inside a persistent terminal tab (`cli-<id>`). */
export function cliTerminalLaunch(id: string): { env: Record<string, string>; script: string } | null {
  wireMcpConfigs()
  const env = cliEnv(id === 'openrouter' ? 'openrouter' : undefined)
  const pathPrefix = `${join(homedir(), '.local', 'bin')}:${join(homedir(), '.local')}:${process.env.PATH ?? ''}`
  env.PATH = pathPrefix

  switch (id) {
    case 'claude':
      return { env, script: `exec "${CLAUDE_BIN}" --plugin-dir "${fileURLToPath(new URL('../../../packages/claude-plugin', import.meta.url))}"` }
    case 'opencode':
      return { env, script: 'command -v opencode >/dev/null 2>&1 && exec opencode || { echo "Installing OpenCode CLI..."; npm install -g --prefix ~/.local opencode-ai && exec ~/.local/bin/opencode; }' }
    case 'openrouter':
      return {
        env: {
          ...env,
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
          ...(env.OPENROUTER_API_KEY ? { ANTHROPIC_AUTH_TOKEN: env.OPENROUTER_API_KEY } : {}),
        },
        script: `if command -v openrouter >/dev/null 2>&1; then exec openrouter; else echo "Launching Claude Code routed via OpenRouter (https://openrouter.ai/api)..."; exec "${CLAUDE_BIN}" --plugin-dir "${fileURLToPath(new URL('../../../packages/claude-plugin', import.meta.url))}"; fi`,
      }
    case 'codex':
      return { env, script: 'command -v codex >/dev/null 2>&1 && exec codex || { echo "Installing OpenAI Codex CLI..."; npm install -g --prefix ~/.local @openai/codex && exec ~/.local/bin/codex; }' }
    case 'antigravity':
      return { env, script: 'if command -v agy >/dev/null 2>&1; then exec agy; elif command -v antigravity >/dev/null 2>&1; then exec antigravity; elif command -v gemini >/dev/null 2>&1; then exec gemini; else echo "Antigravity CLI (agy) ready — type agy or gemini to start."; exec bash -l; fi' }
    case 'grok':
      return { env, script: 'command -v grok >/dev/null 2>&1 && exec grok || { echo "Installing Grok CLI..."; npm install -g --prefix ~/.local @vibe-kit/grok-cli && exec ~/.local/bin/grok; }' }
    default:
      return null
  }
}
