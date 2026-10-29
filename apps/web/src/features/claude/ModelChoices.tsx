import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { FALLBACK_MODELS } from './data'
import { groupModels, isDefaultModel, type ModelFamily, type ModelInfo } from './models'

/**
 * The model choices inside a dropdown: Default (naming the model it is), then each Claude family, followed by the
 * Multi-CLI AI Agents (OpenCode CLI, OpenRouter CLI, Codex CLI, Antigravity CLI, Grok CLI). A family with more than
 * one version expands in place, and the one holding the current choice starts open. `null` means Default.
 */
export function ModelChoices({ models, value, onChange }: { models: ModelInfo[]; value: string | null; onChange: (v: string | null) => void }) {
  // Always ensure the multi-CLI models are present even if the backend only returned Claude SDK models
  const mergedModels = useMemo(() => {
    const existing = new Set(models.map((m) => m.value))
    return [...models, ...FALLBACK_MODELS.filter((m) => m.cli && !existing.has(m.value))]
  }, [models])

  const { def, defName, families, cliFamilies } = useMemo(() => groupModels(mergedModels), [mergedModels])
  const current = isDefaultModel(value) ? 'default' : value!
  const allFamilies = useMemo(() => [...families, ...cliFamilies], [families, cliFamilies])
  const holder = allFamilies.find((f) => f.rows.some((r) => r.value === current))
  const [open, setOpen] = useState<string | null>(holder?.name ?? null)
  const custom = current !== 'default' && !holder

  const renderFamily = (f: ModelFamily) => f.rows.length === 1 ? (
    <DropdownMenuRadioItem key={f.name} value={f.rows[0]!.value} className="items-start">
      <span className="flex flex-col">
        <span>{f.rows[0]!.displayName}</span>
        {f.isCli && f.rows[0]!.description && (
          <span className="text-xs text-muted-foreground">{f.rows[0]!.description.split('·')[0]?.trim()}</span>
        )}
      </span>
    </DropdownMenuRadioItem>
  ) : (
    <Fragment key={f.name}>
      <DropdownMenuItem aria-expanded={open === f.name} onSelect={(e) => { e.preventDefault(); setOpen(open === f.name ? null : f.name) }}>
        <ChevronRight className={cn('text-muted-foreground transition-transform duration-150', open === f.name && 'rotate-90')} />
        <span className="flex-1">{f.name}</span>
        <span className="text-xs text-muted-foreground">
          {holder === f ? holder.rows.find((r) => r.value === current)!.displayName : `${f.rows.length} ${f.isCli ? 'options' : 'versions'}`}
        </span>
      </DropdownMenuItem>
      {open === f.name && f.rows.map((r) => (
        <DropdownMenuRadioItem key={r.value} value={r.value} className="pl-12">
          <span className="flex-1">{r.displayName}</span>
          {r.newest && !f.isCli && <span className="text-xs text-muted-foreground">always the newest</span>}
          {r.newest && f.isCli && <span className="text-xs text-muted-foreground">default</span>}
        </DropdownMenuRadioItem>
      ))}
    </Fragment>
  )

  return (
    <DropdownMenuRadioGroup value={current} onValueChange={(v) => onChange(v === 'default' ? null : v)}>
      <DropdownMenuRadioItem value="default" className="items-start">
        <span className="flex flex-col">
          <span>Default (Claude Code){defName && <span className="text-muted-foreground"> · {defName}</span>}</span>
          <span className="text-xs text-muted-foreground">{def?.description?.split('·')[1]?.trim() || 'What Claude Code recommends for your plan'}</span>
        </span>
      </DropdownMenuRadioItem>
      {families.map(renderFamily)}
      {cliFamilies.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Other AI Agent CLIs
          </DropdownMenuLabel>
          {cliFamilies.map(renderFamily)}
        </>
      )}
      {custom && <DropdownMenuRadioItem value={current} className="font-mono text-xs">{current}</DropdownMenuRadioItem>}
    </DropdownMenuRadioGroup>
  )
}
