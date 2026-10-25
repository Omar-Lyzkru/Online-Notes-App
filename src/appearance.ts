/**
 * Appearance preferences: a small fixed set of choices. The same lists are enforced by firestore.rules
 * (a rules test checks that every value here is accepted and that anything else is rejected).
 */
export const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const

/** Background presets; each has a light and a dark variant in styles.css. */
export const BACKGROUNDS = [
  { id: 'plain', label: 'Plain' },
  { id: 'paper', label: 'Paper' },
  { id: 'mint', label: 'Mint' },
  { id: 'sky', label: 'Sky' },
  { id: 'rose', label: 'Rose' },
] as const

export const FONT_SIZES = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
  { id: 'xlarge', label: 'Extra large' },
] as const

export type Theme = (typeof THEMES)[number]['id']
export type Background = (typeof BACKGROUNDS)[number]['id']
export type FontSize = (typeof FONT_SIZES)[number]['id']

export interface Appearance { theme: Theme; background: Background; fontSize: FontSize }

export const DEFAULT_APPEARANCE: Appearance = { theme: 'light', background: 'plain', fontSize: 'medium' }

const pick = <T extends string>(list: readonly { id: T }[], v: unknown, fallback: T): T =>
  list.some((o) => o.id === v) ? (v as T) : fallback

/** Reads a stored preferences document; a missing document or an unknown/invalid field falls back to its default. */
export function parseAppearance(data: Record<string, unknown> | undefined): Appearance {
  const d = DEFAULT_APPEARANCE
  return {
    theme: pick(THEMES, data?.theme, d.theme),
    background: pick(BACKGROUNDS, data?.background, d.background),
    fontSize: pick(FONT_SIZES, data?.fontSize, d.fontSize),
  }
}

/** Puts the choices on the page root, where styles.css turns them into CSS variables. */
export function applyAppearance(root: HTMLElement, a: Appearance | null) {
  if (!a) {
    delete root.dataset.theme; delete root.dataset.bg; delete root.dataset.font
    return
  }
  root.dataset.theme = a.theme; root.dataset.bg = a.background; root.dataset.font = a.fontSize
}
