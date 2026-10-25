import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { extensions } from '../src/editorExtensions'

const doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ital', marks: [{ type: 'italic' }] },
    ] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] },
    ] },
  ],
}

describe('editor serialization', () => {
  it('round-trips all supported formatting, including checklist state, via a JSON string', () => {
    const a = new Editor({ extensions, content: doc })
    const stored = JSON.stringify(a.getJSON())
    const b = new Editor({ extensions, content: JSON.parse(stored) })
    expect(b.getJSON()).toEqual(a.getJSON())
    const items = b.getJSON().content!.at(-1)!.content!.map((i: any) => i.attrs.checked)
    expect(items).toEqual([true, false])
    expect(stored).toContain('"bold"'); expect(stored).toContain('"italic"')
    expect(stored).toContain('"heading"'); expect(stored).toContain('"bulletList"')
  })
})
