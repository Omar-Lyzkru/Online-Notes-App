import { describe, expect, it } from 'vitest'
import { indexNotes, noteText, searchNotes } from '../src/search'
import { EMPTY_DOC, type Note } from '../src/notesApi'

const p = (...t: (string | { text: string; marks: string[] })[]) => ({
  type: 'paragraph',
  content: t.map((x) => typeof x === 'string' ? { type: 'text', text: x } : { type: 'text', text: x.text, marks: x.marks.map((m) => ({ type: m })) }),
})
const doc = (...c: unknown[]) => JSON.stringify({ type: 'doc', content: c })
const note = (id: string, title: string, content = EMPTY_DOC, rev = 1): Note => ({ id, title, content, rev, updatedAt: rev })
const find = (notes: Note[], q: string) => searchNotes(notes, indexNotes(notes), q).map((n) => n.id)

describe('noteText — readable text of a Tiptap document', () => {
  it('collects text across paragraphs, headings, lists and checklists, one block per line', () => {
    const c = doc(
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Groceries' }] },
      p('milk'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('eggs')] }, { type: 'listItem', content: [p('bread')] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('pay rent')] }] },
    )
    expect(noteText(c).split('\n').filter(Boolean)).toEqual(['Groceries', 'milk', 'eggs', 'bread', 'pay rent'])
  })

  it('does not join neighbouring blocks into one word, but keeps formatted runs of one word together', () => {
    expect(noteText(doc(p('foo'), p('bar')))).not.toContain('foobar')
    expect(noteText(doc(p('hel', { text: 'lo', marks: ['bold'] }, ' world')))).toContain('hello world')
  })

  it('never exposes node names, mark names, attributes or JSON keys as text', () => {
    const c = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan', marks: [{ type: 'bold' }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('x')] }] },
    )
    const t = noteText(c).toLowerCase()
    for (const junk of ['heading', 'paragraph', 'bold', 'level', 'checked', 'tasklist', 'taskitem', 'attrs', 'content', 'type', 'false', 'doc']) {
      expect(t).not.toContain(junk)
    }
  })

  it('gives no text for invalid or unexpected content, rather than searching raw JSON', () => {
    expect(noteText('not json')).toBe('')
    expect(noteText('null')).toBe('')
    expect(noteText(JSON.stringify({ type: 'doc', content: [{ type: 'text', text: 5 }, 'x', null] })).trim()).toBe('')
  })

  it('handles a hard break as a line break', () => {
    expect(noteText(doc({ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }))).toMatch(/a\s*b/)
  })
})

describe('searchNotes', () => {
  const notes = [
    note('t', 'Quarterly Budget', doc(p('nothing here'))),
    note('b', 'Meeting', doc(p('Discuss the BUDGET for next year'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('hire two engineers')] }] })),
    note('x', 'Ideas', doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Garden' }] })),
    note('e', 'Empty'),
  ]

  it('matches titles', () => expect(find(notes, 'quarterly')).toEqual(['t']))
  it('matches body text, including nested list items', () => expect(find(notes, 'engineers')).toEqual(['b']))
  it('is case-insensitive in both directions', () => {
    expect(find(notes, 'BUDGET').sort()).toEqual(['b', 't'])
    expect(find(notes, 'garden')).toEqual(['x'])
    expect(find(notes, 'GARDEN')).toEqual(['x'])
  })
  it('an empty or blank query is the normal list, in the same order', () => {
    expect(find(notes, '')).toEqual(['t', 'b', 'x', 'e'])
    expect(find(notes, '   ')).toEqual(['t', 'b', 'x', 'e'])
  })
  it('reports no matches as an empty result', () => expect(find(notes, 'zebra')).toEqual([]))
  it('does not match JSON structure or formatting names', () => {
    for (const q of ['paragraph', 'heading', 'bulletList', 'listItem', 'doc', 'content', 'level', 'type', '"text"']) expect(find(notes, q)).toEqual([])
  })
  it('requires every word, in any order, across title and body', () => {
    expect(find(notes, 'meeting budget')).toEqual(['b'])
    expect(find(notes, 'year budget')).toEqual(['b'])
    expect(find(notes, 'quarterly engineers')).toEqual([])
  })
  it('treats regex characters literally', () => expect(find(notes, '.*')).toEqual([]))
  it('follows edits: re-indexing after a note changes finds the new text and drops the old', () => {
    const first = indexNotes(notes)
    const edited = notes.map((n) => n.id === 't' ? note('t', 'Quarterly Budget', doc(p('zebra crossing')), 2) : n)
    const next = indexNotes(edited, first)
    expect(searchNotes(edited, next, 'zebra').map((n) => n.id)).toEqual(['t'])
    expect(searchNotes(edited, next, 'nothing here')).toEqual([])
    expect(searchNotes(edited, next, 'quarterly').map((n) => n.id)).toEqual(['t'])
  })
  it('follows a rename and a deletion', () => {
    const idx = indexNotes(notes)
    const renamed = notes.map((n) => n.id === 'e' ? note('e', 'Zebra', EMPTY_DOC, 1) : n)
    expect(searchNotes(renamed, indexNotes(renamed, idx), 'zebra').map((n) => n.id)).toEqual(['e'])
    const without = notes.filter((n) => n.id !== 'b')
    expect(searchNotes(without, indexNotes(without, idx), 'engineers')).toEqual([])
  })
})
