/**
 * Pinyin matching for the `@` menu.
 *
 * Chinese names are typed in latin letters far more often than by IME in a search
 * box: `zs`, `zhangsan`, `yang` are all expected spellings of 张三. This module
 * turns a display name into the three latin forms people type — initials, full
 * syllables, and the concatenated pinyin — and ranks a query against them.
 *
 * The conversion is cached per name because the composer re-queries on every
 * keystroke while the candidate set (contacts plus up to a few hundred groups)
 * never changes between keystrokes.
 *
 * Bundled at build time (`build.mjs`), so the Host needs no runtime dependency.
 */
import { match as pinyinMatch, pinyin } from 'pinyin-pro'

/** Latin projections of one display name. */
export interface NameForms {
  /** First letter of every syllable: 张三 → `zs`. */
  initials: string
  /** Concatenated syllables without tones: 张三 → `zhangsan`. */
  full: string
  /** Syllables in order: [`ou`, `yang`, `tao`]. */
  syllables: string[]
}

const CACHE_LIMIT = 5000
const cache = new Map<string, NameForms>()

/**
 * Latin projections of one name, cached.
 * @param text - display name, possibly mixing CJK and latin.
 */
export function nameForms(text: string): NameForms {
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  let forms: NameForms
  try {
    const initials = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' })
    const syllables = pinyin(text, { pattern: 'pinyin', toneType: 'none', type: 'array' })
    forms = {
      initials: initials.join('').toLowerCase(),
      full: syllables.join('').toLowerCase(),
      syllables: syllables.map((syllable) => syllable.toLowerCase()),
    }
  } catch {
    forms = { initials: '', full: '', syllables: [] }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(text, forms)
  return forms
}

/**
 * Rank one name against one lowercase query.
 *
 * Higher is better; `-1` means "no match". Ordering is deliberate: a literal
 * substring beats an initials hit, which beats anything the fuzzy syllable
 * matcher had to stretch for.
 *
 * @param query - already lowercased, non-empty.
 * @param name - display name.
 * @param enName - optional English name shown by Feishu for some contacts.
 * @returns score in `[-1, 100]`.
 */
export function matchScore(query: string, name: string, enName?: string): number {
  const lowered = name.toLowerCase()
  const literal = lowered.indexOf(query)
  if (literal >= 0) return 100 - Math.min(literal, 40)
  if (enName !== undefined && enName.toLowerCase().includes(query)) return 90

  const forms = nameForms(name)
  if (forms.initials.startsWith(query)) return 80
  if (forms.initials.includes(query)) return 60
  if (forms.full.startsWith(query)) return 50
  if (forms.full.includes(query)) return 40
  if (forms.syllables.some((syllable) => syllable.startsWith(query))) return 30

  // Last resort: pinyin-pro's fuzzy matcher spans syllables and mixes initials
  // with full readings (`oyang` → 欧 + 阳), which the forms above cannot express.
  try {
    if (pinyinMatch(name, query) !== null) return 20
  } catch {
    // a conversion failure simply means "no fuzzy match"
  }
  return -1
}

/** Test helper: drop the conversion cache. */
export function resetNameFormsCache(): void {
  cache.clear()
}
