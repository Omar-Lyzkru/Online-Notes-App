import { useEffect, useRef, useState } from 'react'
import {
  GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User,
} from 'firebase/auth'
import { auth, db } from './firebase'
import { ConflictError, DeleteOutcomeUnknownError, createNote, deleteNote, subscribeNotes, type Note } from './notesApi'
import { Editor, type EditorHandle } from './Editor'

/** How long leaving a note may wait for pending saves before the user is asked what to do. */
const SETTLE_MS = 3000

/** Resolves with `p`'s value, or 'timeout' after `ms` (p keeps running). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms) })
  try { return await Promise.race([p, timeout]) } finally { clearTimeout(timer) }
}

/** True when the open note has nothing unsaved, after giving pending work a chance to finish. */
async function settledForLeave(h: EditorHandle | null): Promise<boolean> {
  if (!h || h.state() === 'saved') return true
  return (await within(h.settle(), SETTLE_MS)) === 'saved' && h.state() === 'saved'
}

/** What the user is told about the last delete. Only 'done' means the server confirmed it. */
interface Deletion {
  id: string
  title: string
  /** pending: sent, no answer yet · done: server confirmed · failed/conflict: server did not delete · unknown: no answer after sending */
  phase: 'pending' | 'done' | 'failed' | 'conflict' | 'unknown'
  text: string
}

const quoted = (title: string) => `\u201c${title}\u201d`

function failureReason(e: unknown): string {
  const code = (e as { code?: string })?.code
  if (code === 'unavailable' || /offline/i.test(String((e as Error)?.message))) {
    return 'the server could not be reached. Check your connection and try again.'
  }
  if (code === 'permission-denied') return 'permission was denied.'
  return String((e as Error)?.message ?? e)
}

const unsavedPrompt = (kind: 'signOut' | 'switch') => kind === 'signOut'
  ? 'Some changes in the open note could not be saved. Sign out and lose them?\n\nChoose Cancel to stay signed in and keep your draft.'
  : 'This note has changes that could not be saved. Switch anyway and lose them?'

const unresolvedDeletePrompt = (d: Deletion, kind: 'signOut' | 'switch') =>
  `${d.phase === 'pending'
    ? `A delete is still waiting for the server, so it is not known whether ${quoted(d.title)} has been deleted.`
    : `The server did not confirm whether ${quoted(d.title)} was deleted. It may still exist.`}\n\n`
  + `${kind === 'signOut' ? 'Sign out' : 'Switch notes'} anyway? Unsaved edits in that note will be lost.\n\nChoose Cancel to stay and wait for the result.`

type Auth = { status: 'loading' } | { status: 'out'; error?: string } | { status: 'in'; user: User }

export default function App() {
  const [a, setA] = useState<Auth>({ status: 'loading' })
  useEffect(() => onAuthStateChanged(auth,
    (user) => setA(user ? { status: 'in', user } : { status: 'out' }),
    (e) => setA({ status: 'out', error: e.message })), [])

  if (a.status === 'loading') return <p className="center">Loading…</p>
  if (a.status === 'out') {
    return (
      <main className="center">
        <h1>Online Notes</h1>
        <p>Sign in to see your notes.</p>
        <button onClick={() => signInWithPopup(auth, new GoogleAuthProvider())
          .catch((e) => setA({ status: 'out', error: e.message }))}>Sign in with Google</button>
        {a.error && <p role="alert" className="err">Sign-in failed: {a.error}</p>}
      </main>
    )
  }
  // key=uid: a different user can never inherit another user's component state
  return <Notes key={a.user.uid} user={a.user} />
}

function Notes({ user }: { user: User }) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [pendingWrites, setPendingWrites] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [leaving, setLeaving] = useState(false)
  const editor = useRef<EditorHandle | null>(null)
  const guard = useRef(false)
  const [deletion, setDeletion] = useState<Deletion | null>(null)
  const deletionNow = useRef<Deletion | null>(null) // always current, unlike the state, for code that awaits
  const pendingDelete = useRef<Promise<void> | null>(null)
  const selNow = useRef<string | null>(null) // the open note, as seen by code that answers later
  const setDel = (d: Deletion | null) => { deletionNow.current = d; setDeletion(d) }

  useEffect(() => subscribeNotes(db, user.uid,
    (n, cache, pending) => { setNotes(n); setFromCache(cache); setPendingWrites(pending); setErr('') },
    (e) => setErr(e.message)), [user.uid])

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  /**
   * Runs `go` only when leaving is safe. An unresolved delete gets a few seconds to finish, then the user
   * must explicitly accept that its outcome is unknown. Otherwise pending edits get a chance to save
   * first; if they still cannot be (offline, conflict, slow server) the user must explicitly choose to
   * discard. Cancelling leaves everything as it was, draft included.
   */
  const leaveNote = async (kind: 'signOut' | 'switch', go: () => void | Promise<void>) => {
    if (guard.current) return
    guard.current = true; setLeaving(true)
    try {
      if (pendingDelete.current) await within(pendingDelete.current, SETTLE_MS)
      const d = deletionNow.current
      if (d && (d.phase === 'pending' || d.phase === 'unknown')) {
        if (!confirm(unresolvedDeletePrompt(d, kind))) return
      } else if (!(await settledForLeave(editor.current)) && !confirm(unsavedPrompt(kind))) return
      await go()
    } finally { guard.current = false; setLeaving(false) }
  }
  const select = (id: string | null) =>
    id === sel ? Promise.resolve() : leaveNote('switch', () => setSel(id))
  // The note is gone or its draft was already discarded on purpose: nothing left to protect.
  const close = () => setSel(null)

  /**
   * Deletes the open note after the user confirmed. The note stays open, with its draft, until the server
   * acknowledges: the delete expects the revision on screen at this moment (editor.hold() freezes it), so
   * a note that changed elsewhere is not deleted and must be reviewed and confirmed again.
   *
   * The answer can arrive at any time — after the user switched notes (the note's editor is then gone) or
   * signed out. Whatever happens, this attempt ends in a terminal notice: the notice is set first, and the
   * editor is only touched afterwards, best-effort.
   */
  const requestDelete = () => {
    if (!shown || pendingDelete.current) return
    if (!confirm('Delete this note permanently?')) return
    const h = editor.current, id = shown.id, title = shown.title || 'Untitled'
    const mine: Deletion = { id, title, phase: 'pending', text: `Deleting ${quoted(title)}\u2026 waiting for the server to confirm. It has not been deleted yet.` }
    setDel(mine)
    const withEditor = (f: (h: EditorHandle) => void) => {
      try { if (h) f(h) } catch { /* the editor was unmounted: there is nothing on screen left to restore */ }
    }
    const run = (async () => {
      try {
        const rev = h ? await h.hold() : shown.rev
        const result = await deleteNote(db, user.uid, id, rev)
        setDel({ id, title, phase: 'done', text: result === 'deleted'
          ? `${quoted(title)} was deleted.`
          : `${quoted(title)} was already deleted.` })
        withEditor((h) => void h.abandon())
        setSel((s) => (s === id ? null : s))
      } catch (e) {
        if (e instanceof ConflictError && e.remote) {
          const newer = e.remote
          const open = selNow.current === id
          setDel({ id, title, phase: 'conflict', text: `${quoted(title)} was not deleted: it was changed on another device after you opened it. `
            + (open
              ? 'Review the newer version first (if you have unsaved edits, choose how to resolve the conflict shown), then choose Delete note again if you still want to delete it.'
              : 'Open it again to review the newer version, then choose Delete note if you still want to delete it.') })
          withEditor((h) => { h.release(); h.review(newer) })
        } else if (e instanceof DeleteOutcomeUnknownError) {
          setDel({ id, title, phase: 'unknown', text: `Could not confirm whether ${quoted(title)} was deleted: the connection was lost while the server was deciding. It may still exist; it leaves the list if it was deleted. You can try deleting it again.` })
          withEditor((h) => h.release())
        } else {
          setDel({ id, title, phase: 'failed', text: `${quoted(title)} was not deleted: ${failureReason(e)}` })
          withEditor((h) => h.release())
        }
      } finally {
        // Safety net: if anything above threw before a terminal notice was set, do not stay "pending" forever.
        if (deletionNow.current === mine) {
          setDel({ id, title, phase: 'unknown', text: `Could not confirm whether ${quoted(title)} was deleted: something went wrong while handling the server's answer. It may still exist.` })
        }
      }
    })().catch(() => { /* already reported through the notice (or the safety net above); callers await this promise and must not see a rejection */ })
    pendingDelete.current = run.finally(() => { pendingDelete.current = null })
  }

  // An unconfirmed delete is settled by server data: a snapshot that is neither from the cache nor carrying
  // unacknowledged local writes, and that no longer lists the note. (Deletes here are transactions, which cause
  // no optimistic local event, so such a removal came from the server.) Checked whenever the snapshot or the
  // notice changes, so it does not matter which of the two arrives first.
  const authoritative = !fromCache && !pendingWrites
  useEffect(() => {
    if (deletion?.phase === 'unknown' && authoritative && notes && !notes.some((n) => n.id === deletion.id)) {
      setSel((s) => (s === deletion.id ? null : s))
      setDel({ ...deletion, phase: 'done', text: `${quoted(deletion.title)} was deleted (confirmed by the server).` })
    }
  }, [notes, authoritative, deletion])
  const wrap = (p: Promise<unknown>) => p.catch((e) => setErr(String(e.message ?? e)))

  const current = sel ? notes?.find((n) => n.id === sel) ?? null : null
  // keep the editor mounted (with its draft) if the note vanished remotely
  const [last, setLast] = useState<Note | null>(null)
  useEffect(() => { if (current) setLast(current) }, [current])
  const shown = sel ? (current ?? last) : null
  selNow.current = sel

  return (
    <div className="app">
      <header>
        <strong>Online Notes</strong>
        <span>{user.displayName ?? user.email}</span>
        <button disabled={leaving} onClick={() => void leaveNote(
          'signOut', () => signOut(auth).catch((e) => setErr(String(e.message ?? e))),
        )}>Sign out</button>
      </header>
      {(!online || fromCache) && <div className="banner" role="status">Not connected to the server. Changes cannot be saved until you reconnect.</div>}
      {err && <div className="banner err" role="alert">{err}</div>}
      {deletion && (
        <div className={deletion.phase === 'pending' || deletion.phase === 'done' ? 'banner' : 'banner err'}
          role={deletion.phase === 'pending' || deletion.phase === 'done' ? 'status' : 'alert'}>
          {deletion.text}{' '}
          {deletion.phase !== 'pending' && <button onClick={() => setDel(null)}>Dismiss</button>}
        </div>
      )}
      <div className="body">
        <nav className="sidebar" aria-label="Notes">
          <button onClick={() => wrap(createNote(db, user.uid).then(select))}>+ New note</button>
          {notes === null ? <p>Loading notes…</p>
            : notes.length === 0 ? <p>No notes yet.</p>
            : <ul>{notes.map((n) => (
              <li key={n.id}>
                <button className={n.id === sel ? 'sel' : ''} disabled={leaving} onClick={() => void select(n.id)}>{n.title || 'Untitled'}</button>
              </li>))}</ul>}
        </nav>
        <main className="main">
          {shown ? (
            <>
              <Editor key={shown.id} uid={user.uid} note={current} online={online}
                handleRef={editor} onGone={close} />
              <button className="danger" disabled={deletion?.phase === 'pending'} onClick={requestDelete}>Delete note</button>
            </>
          ) : <p className="center">{notes === null ? 'Loading…' : 'Select or create a note.'}</p>}
        </main>
      </div>
    </div>
  )
}
