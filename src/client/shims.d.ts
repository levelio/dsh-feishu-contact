/**
 * Types for modules the DSH Web kernel provides at runtime.
 *
 * They are not installed in this package (the GUI resolves them from its own
 * module table), so the declarations live here to keep the type check honest.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export interface ReferenceChipProps {
    appearance?: 'file' | 'folder' | 'session'
    label: string
    title?: string
    onActivate?: () => void
  }

  export function ReferenceChip(props: ReferenceChipProps): ReactNode
}
