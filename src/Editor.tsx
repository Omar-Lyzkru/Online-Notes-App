import { useEffect, useReducer, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { extensions } from './editorExtensions'
import { SaveController, type SaveState } from './saveController'
import { createNote, saveNote, type Note } from './notesApi'
import { auth, db } from './firebase'

const LABEL: Record<SaveState, string> = {
  saved: 'Saved', dirty: 'Unsaved changes…', saving: 'Saving…',
  error: 'Save failed — your draft is kept here', conflict: 'Conflict',
}

/** What the parent may ask of the open note. The save state lives only in the note's own controller. */
export interface EditorHandle {
  state(): SaveState
  /** Resolves with the final state once pending work is done; 'saved' means nothing is unsaved. */
  settle(): Promise<SaveState>
  /** A delete is being sent: pause saving and remote changes, keep the draft; resolves with the revision on screen. */
  hold(): Promise<number | null>
  /** The delete did not happen: resume (a kept draft is saved as usual). */
  release(): void
  /** Show what the server now has (e.g. after a refused delete): applied if the editor is clean, otherwise a conflict. */
  review(remote: Note): void
  /** The note is gone: drop the draft and stop all writes; resolves after any write in flight. */
  abandon(): Promise<void>
}

interface Props {
  uid: string
  /** Latest remote note; null means it was deleted elsewhere. */
  note: Note | null
  online: boolean
  handleRef: { current: EditorHandle | null }
  /** The note is gone and nothing unsaved remains (deleted elsewhere, or the draft was discarded). */
  onGone: () => void
}

export function Editor({ uid, note, online, handleRef, onGone }: Props) {
  const initial = useRef(note!)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [title, setTitle] = useState(initial.current.title)
  const ctl = useRef<SaveController>(null as unknown as SaveController)
  const titleRef = useRef(title)
  if (!ctl.current) {
    ctl.current = new SaveController(
      initial.current.rev,
      (d, rev) => saveNote(db, uid, initial.current.id, d, rev),
      rerender,
    )
  }
  const c = ctl.current

  const editor = useEditor({
    extensions,
    content: JSON.parse(initial.current.content),
    onUpdate: ({ editor }) =>
      c.edit({ title: titleRef.current, content: JSON.stringify(editor.getJSON()) }),
  })

  const show = (n: Note) => {
    titleRef.current = n.title
    setTitle(n.title)
    editor?.commands.setContent(JSON.parse(n.content), { emitUpdate: false })
  }

  const feed = (n: Note | null) => {
    const r = c.onRemote(n)
    if (r === 'apply') n ? show(n) : onGone()
  }
  const feedNow = useRef(feed)
  feedNow.current = feed // the handle below is created once; it must always call the latest closure
  // Also re-evaluated when the save state changes (or a delete hold ends): a newer revision that arrived
  // while our write or delete was in flight was ignored then, and must be looked at again afterwards.
  useEffect(() => {
    if (!editor) return
    feed(note)
  }, [note, c.state, c.held])

  useEffect(() => {
    if (online && c.state === 'error') void c.flush() // reconnection: retry the kept draft
  }, [online])

  useEffect(() => {
    // The parent may call the handle after this editor has been unmounted (a delete answered late, after the
    // user switched notes). Those calls must be harmless: the Tiptap editor is destroyed by then.
    let alive = true
    const handle: EditorHandle = {
      state: () => c.state, settle: () => c.settle(), hold: () => c.hold(),
      release: () => { if (alive) c.release() },
      review: (n) => { if (alive) feedNow.current(n) },
      abandon: () => c.abandon(),
    }
    handleRef.current = handle
    return () => {
      alive = false
      if (handleRef.current === handle) handleRef.current = null
      void c.flush()
      c.dispose()
    }
  }, [])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (c.state !== 'saved') e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const onTitle = (v: string) => {
    titleRef.current = v
    setTitle(v)
    c.edit({ title: v, content: JSON.stringify(editor!.getJSON()) })
  }

  const useRemote = () => { const r = c.useRemote(); r ? show(r) : onGone() }
  const saveCopy = async () => {
    if (!c.draft) return
    try {
      const id = await createNote(db, auth.currentUser!.uid)
      await saveNote(db, uid, id, { ...c.draft, title: (c.draft.title || 'Untitled') + ' (my copy)' }, 1)
      useRemote()
    } catch { alert('Could not save a copy. Your draft is still here.') }
  }

  const btn = (label: string, cmd: () => void, active: boolean) => (
    <button type="button" className={active ? 'on' : ''} aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} onClick={cmd}>{label}</button>
  )
  const chain = () => editor!.chain().focus()

  return (
    <section className="editor">
      <input className="title" value={title} placeholder="Untitled" aria-label="Title"
        onChange={(e) => onTitle(e.target.value)} />
      {editor && (
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          {btn('B', () => chain().toggleBold().run(), editor.isActive('bold'))}
          {btn('I', () => chain().toggleItalic().run(), editor.isActive('italic'))}
          {btn('H1', () => chain().toggleHeading({ level: 1 }).run(), editor.isActive('heading', { level: 1 }))}
          {btn('H2', () => chain().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
          {btn('• List', () => chain().toggleBulletList().run(), editor.isActive('bulletList'))}
          {btn('☑ Checklist', () => chain().toggleTaskList().run(), editor.isActive('taskList'))}
        </div>
      )}
      <div className={`status ${c.state}`} role="status">
        {c.held ? 'Waiting for the server to confirm the delete…' : LABEL[c.state]}
        {c.state === 'error' && <button onClick={() => void c.flush()}>Retry</button>}
      </div>
      {c.state === 'conflict' && (
        <div className="conflict" role="alert">
          {c.remote
            ? 'This note was changed on another device after you started editing. Nothing has been overwritten.'
            : 'This note was deleted on another device. Your draft is still here.'}
          <div>
            <button onClick={() => c.keepMine()}>{c.remote ? 'Keep mine (overwrite other version)' : 'Restore my draft'}</button>
            {c.remote && <button onClick={useRemote}>Use other version (discard mine)</button>}
            {c.remote && <button onClick={() => void saveCopy()}>Save mine as a new note, use other</button>}
            {!c.remote && <button onClick={useRemote}>Discard my draft</button>}
          </div>
        </div>
      )}
      <EditorContent editor={editor} className="content" />
    </section>
  )
}
