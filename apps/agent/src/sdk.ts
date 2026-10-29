// The Agent SDK is loaded from the system-wide Claude install (deploy/claude-update.sh) on Linux, or from
// data/claude-sdk / node_modules on local machines, so Chat mode and CLI mode always run the real Claude Code.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('../../..', import.meta.url))
export const CLAUDE_HOME = process.env.DEVDASH_CLAUDE_HOME
  ?? (existsSync('/opt/devdash/claude/current') ? '/opt/devdash/claude/current' : join(ROOT_DIR, 'data', 'claude-sdk'))

function resolveClaudeBin(): string {
  const candidates = [
    process.env.DEVDASH_CLAUDE_BIN,
    join(CLAUDE_HOME, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    join(CLAUDE_HOME, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
  ].filter((c): c is string => Boolean(c))
  for (const c of candidates) if (existsSync(c)) return c
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

export const CLAUDE_BIN = resolveClaudeBin()

// Minimal types for the parts of @anthropic-ai/claude-agent-sdk DevDash uses (full types: sdk.d.ts in the package).
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
export type SDKMessage = { type: string; subtype?: string; uuid?: string; session_id?: string; [k: string]: unknown }
export type SDKUserMessage = {
  type: 'user'
  message: { role: 'user'; content: unknown[] }
  parent_tool_use_id: null
  session_id?: string
  uuid?: string
}
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
export type Query = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  /** Session-scoped settings, applied live (e.g. { effortLevel: 'xhigh' }; null resets to the model default). */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  supportedCommands(): Promise<{ name: string; description: string; argumentHint?: string }[]>
  /** The data behind /usage (experimental in the SDK, so optional here). */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(o?: { skipBehaviors?: boolean }): Promise<{
    subscription_type: string | null
    rate_limits_available: boolean
    rate_limits: Record<string, unknown> | null
  }>
  supportedModels(): Promise<{ value: string; displayName: string; description?: string }[]>
  /** The data behind /context. 'summary' answers from the last response's usage, without token-count calls. */
  getContextUsage(o?: { detail?: 'summary' | 'full' }): Promise<{ percentage: number; totalTokens: number; maxTokens: number }>
  /** Remote Control (claude.ai/code and the Claude app). Not in the SDK's public types yet, so optional here. */
  enableRemoteControl?(enabled: boolean, name?: string): Promise<{ session_url?: string } | undefined>
  /** Stops a background task (a shell, subagent or monitor) by its task id. */
  stopTask(taskId: string): Promise<void>
  close(): void
}
type Sdk = {
  query(p: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }): Query
  getSessionMessages(id: string, o?: { dir?: string; limit?: number; offset?: number }): Promise<unknown[]>
  /** summary = the /rename title, else Claude Code's own generated title, else the first prompt. */
  getSessionInfo(id: string, o?: { dir?: string }): Promise<{ summary: string; customTitle?: string } | undefined>
  renameSession(id: string, title: string, o?: { dir?: string }): Promise<void>
}

let sdk: Promise<Sdk> | undefined
export const loadSdk = () => {
  if (!sdk) {
    const candidates = [
      join(CLAUDE_HOME, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
      join(ROOT_DIR, 'data/claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
      join(ROOT_DIR, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
    ]
    const found = candidates.find((p) => existsSync(p)) ?? candidates[0]!
    sdk = import(pathToFileURL(found).href) as Promise<Sdk>
  }
  return sdk
}
