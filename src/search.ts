import type { Note } from './notesApi'

/**
 * The readable text of a note's Tiptap document: only the `text` of text nodes. Node and mark names,
 * attributes (heading levels, checked flags) and JSON keys are never part of it. Block nodes end a line so
 * words of neighbouring paragraphs or list items do not run together; adjacent text nodes (bold/italic runs
 * inside one word) are joined as they are. Content that is not a valid document yields no text.
 */
export function noteText(content: string): string {
  let doc: unknown
  try { doc = JSON.parse(content) } catch { return '' }
  const out: string[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const node = n as { type?: unknown; text?: unknown; content?: unknown }
    if (node.type === 'text') { if (typeof node.text === 'string') out.push(node.text); return }
    if (Array.isArray(node.content)) node.content.forEach(walk)
    out.push('\n')
  }
  walk(doc)
  return out.join('')
}

/** One entry per note: lowercase title and body, built once per change of the note rather than once per keystroke. */
export interface Indexed { note: Note; haystack: string }

export function indexNotes(notes: Note[], prev?: Map<string, Indexed>): Map<string, Indexed> {
  const next = new Map<string, Indexed>()
  for (const note of notes) {
    const old = prev?.get(note.id)
    next.set(note.id, old && old.note.content === note.content && old.note.title === note.title
      ? { ...old, note }
      : { note, haystack: `${note.title}\n${noteText(note.content)}`.toLowerCase() })
  }
  return next
}

/** Case-insensitive; every whitespace-separated word of the query must occur in the title or the body. */
export function searchNotes(notes: Note[], index: Map<string, Indexed>, query: string): Note[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return notes
  return notes.filter((n) => {
    const h = index.get(n.id)?.haystack ?? ''
    return terms.every((t) => h.includes(t))
  })
}
