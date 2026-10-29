import { Children, isValidElement, type ChangeEvent, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

type Opt = { value: string; label: ReactNode; disabled?: boolean }

function collectOptions(nodes: ReactNode, out: Opt[] = []): Opt[] {
  for (const child of Children.toArray(nodes)) {
    if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(child)) continue
    if (child.type === 'option') {
      const raw = child.props.value !== undefined ? child.props.value : typeof child.props.children === 'string' ? child.props.children : ''
      out.push({ value: String(raw), label: child.props.children, disabled: child.props.disabled })
    } else if (child.props.children) {
      collectOptions(child.props.children, out)
    }
  }
  return out
}

/**
 * Themed option picker matching the agOS design system (replaces the unstyled browser native <select> popup
 * across every page while keeping the standard <NativeSelect><option .../></NativeSelect> API).
 */
export function NativeSelect({
  className, children, value, defaultValue, onChange, disabled, id, 'aria-label': ariaLabel,
}: ComponentProps<'select'>) {
  const options = collectOptions(children)
  const current = String(value ?? defaultValue ?? options[0]?.value ?? '')
  const selected = options.find((o) => o.value === current) ?? options[0]
  const normalizedClass = className?.replace(/\[&_select\]:/g, '[&_[data-slot=select-trigger]]:')

  const handleChange = (next: string) => {
    if (!onChange) return
    const synthetic = {
      target: { value: next },
      currentTarget: { value: next },
    } as unknown as ChangeEvent<HTMLSelectElement>
    onChange(synthetic)
  }

  return (
    <div className={cn('relative', normalizedClass)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            id={id}
            aria-label={ariaLabel}
            disabled={disabled}
            data-slot="select-trigger"
            className="flex h-8 pointer-coarse:h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-left text-base shadow-xs outline-none transition-colors hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 md:text-sm dark:bg-input/30 dark:hover:bg-input/50"
          >
            <span className="truncate">{selected?.label ?? current}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuRadioGroup value={current} onValueChange={handleChange}>
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
