import { useEffect, useMemo, useRef, useState } from 'react'
import {
  GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User,
} from 'firebase/auth'
import { auth, db } from './firebase'
import { ConflictError, DeleteOutcomeUnknownError, createNote, deleteNote, subscribeNotes, type Note } from './notesApi'
import { Editor, type EditorHandle } from './Editor'
import { Settings } from './Settings'
import { usePreferences } from './usePreferences'
import { indexNotes, searchNotes, type Indexed } from './search'

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

/** What is still unresolved about deletes, in words, for the question asked before leaving. */
const unresolvedLine = (phase: 'pending' | 'unknown', title: string) => phase === 'pending'
  ? `A delete is still waiting for the server, so it is not known whether ${quoted(title)} has been deleted.`
  : `The server did not confirm whether ${quoted(title)} was deleted. It may still exist.`

const leavePrompt = (kind: 'signOut' | 'switch', lines: string[], unsaved: boolean) => {
  const parts = [...lines]
  if (unsaved) {
    parts.push(kind === 'signOut'
      ? 'Some changes in the open note could not be saved. They will be lost if you sign out.'
      : 'This note has changes that could not be saved. They will be lost if you switch.')
  }
  const cancel = unsaved
    ? `Choose Cancel to stay ${kind === 'signOut' ? 'signed in' : 'on this note'} and keep your draft.`
    : 'Choose Cancel to stay and wait for the result.'
  return `${parts.join('\n\n')}\n\n${kind === 'signOut' ? 'Sign out' : 'Switch notes'} anyway?\n\n${cancel}`
}

/**
 * Asked only when a delete of the open note is still waiting and the note holds unsaved edits. Those edits
 * are frozen until the server answers and cannot be saved meanwhile, so signing out now would lose them
 * even if the delete is then refused.
 */
const heldDraftPrompt = (title: string) =>
  `A delete of ${quoted(title)} is still waiting for the server, and the open note has unsaved edits that are held until it answers. `
  + 'If you sign out now those edits are lost, even if the delete is then refused.\n\nSign out anyway?\n\nChoose Cancel to stay signed in and keep your draft.'

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
  // The latest delete attempt, as a notice. It can be dismissed; what is still unresolved cannot (see `unconfirmed`).
  const [deletion, setDeletion] = useState<Deletion | null>(null)
  const deletionNow = useRef<Deletion | null>(null) // always current, unlike the state, for code that awaits
  const pendingDelete = useRef<Promise<void> | null>(null)
  const selNow = useRef<string | null>(null) // the open note, as seen by code that answers later
  // Notes whose delete ended without an answer (id -> title): kept for the session, whatever happens to the
  // notice, until the server shows the note gone or a later delete gets a definite answer.
  const [unconfirmed, setUnconfirmed] = useState<Record<string, string>>({})
  const unconfirmedNow = useRef<Record<string, string>>({})
  // The user tried to leave while the open note's edits were held by a pending delete: we stayed.
  const [deferred, setDeferred] = useState(false)
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const prefs = usePreferences(user.uid)
  const setDel = (d: Deletion | null) => {
    deletionNow.current = d; setDeletion(d)
    if (d?.phase !== 'pending') setDeferred(false)
  }
  const setUnc = (u: Record<string, string>) => { unconfirmedNow.current = u; setUnconfirmed(u) }
  const markUnconfirmed = (id: string, title: string) => setUnc({ ...unconfirmedNow.current, [id]: title })
  const clearUnconfirmed = (...ids: string[]) => {
    const u = { ...unconfirmedNow.current }
    for (const id of ids) delete u[id]
    setUnc(u)
  }

  useEffect(() => subscribeNotes(db, user.uid,
    (n, cache, pending) => { setNotes(n); setFromCache(cache); setPendingWrites(pending); setErr('') },
    (e) => setErr(e.message)), [user.uid])

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  /**
   * Runs `go` only when leaving is safe. Order of concerns:
   *  1. A delete still in flight gets a few seconds to finish.
   *  2. If it is still waiting and the open note is the one being deleted and holds unsaved edits, those edits
   *     are frozen until the server answers. Switching notes then simply does not happen (the edits stay, and
   *     so does the chance to resolve a refused delete); signing out asks, saying plainly that they are lost.
   *  3. Otherwise pending edits get a chance to save first.
   *  4. If something is still unsaved, or a delete is unresolved (waiting, or answered with "unknown"), the
   *     user must explicitly accept that. Switching only cares about a delete of the open note; signing out
   *     about any of them. Cancelling leaves everything as it was, draft included.
   */
  const leaveNote = async (kind: 'signOut' | 'switch', go: () => void | Promise<void>) => {
    if (guard.current) return
    guard.current = true; setLeaving(true)
    try {
      if (pendingDelete.current) await within(pendingDelete.current, SETTLE_MS)
      const h = editor.current, openId = selNow.current, d = deletionNow.current
      if (d?.phase === 'pending' && d.id === openId && h && h.state() !== 'saved') {
        if (kind === 'switch') { setDeferred(true); return }
        if (!confirm(heldDraftPrompt(d.title))) return
        await go(); return
      }
      const lines: string[] = []
      if (d?.phase === 'pending' && (kind === 'signOut' || d.id === openId)) lines.push(unresolvedLine('pending', d.title))
      for (const [id, title] of Object.entries(unconfirmedNow.current)) {
        if (kind === 'signOut' || id === openId) lines.push(unresolvedLine('unknown', title))
      }
      const unsaved = !(await settledForLeave(h))
      if ((unsaved || lines.length) && !confirm(leavePrompt(kind, lines, unsaved))) return
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
   * The answer can arrive at any time — after the user signed out (switching away is deferred while edits are
   * held, but possible without edits). Whatever happens, this attempt ends in a terminal notice: the notice is
   * set first, and the editor is only touched afterwards, best-effort.
   */
  const requestDelete = () => {
    if (!shown || pendingDelete.current) return
    if (!confirm('Delete this note permanently?')) return
    const h = editor.current, id = shown.id, title = shown.title || 'Untitled'
    const mine: Deletion = { id, title, phase: 'pending', text: `Deleting ${quoted(title)}… waiting for the server to confirm. It has not been deleted yet.` }
    setDel(mine)
    const withEditor = (f: (h: EditorHandle) => void) => {
      try { if (h) f(h) } catch { /* the editor was unmounted: there is nothing on screen left to restore */ }
    }
    const run = (async () => {
      try {
        const rev = h ? await h.hold() : shown.rev
        const result = await deleteNote(db, user.uid, id, rev)
        clearUnconfirmed(id)
        setDel({ id, title, phase: 'done', text: result === 'deleted'
          ? `${quoted(title)} was deleted.`
          : `${quoted(title)} was already deleted.` })
        withEditor((h) => void h.abandon())
        setSel((s) => (s === id ? null : s))
      } catch (e) {
        if (e instanceof ConflictError && e.remote) {
          const newer = e.remote
          const open = selNow.current === id
          clearUnconfirmed(id) // the server showed the note: an earlier unanswered attempt did not delete it
          setDel({ id, title, phase: 'conflict', text: `${quoted(title)} was not deleted: it was changed on another device after you opened it. `
            + (open
              ? 'Review the newer version first (if you have unsaved edits, choose how to resolve the conflict shown), then choose Delete note again if you still want to delete it.'
              : 'Open it again to review the newer version, then choose Delete note if you still want to delete it.') })
          withEditor((h) => { h.release(); h.review(newer) })
        } else if (e instanceof DeleteOutcomeUnknownError) {
          markUnconfirmed(id, title)
          setDel({ id, title, phase: 'unknown', text: `Could not confirm whether ${quoted(title)} was deleted: the connection was lost while the server was deciding. It may still exist; it leaves the list if it was deleted. You can try deleting it again.` })
          withEditor((h) => h.release())
        } else {
          setDel({ id, title, phase: 'failed', text: `${quoted(title)} was not deleted: ${failureReason(e)}` })
          withEditor((h) => h.release())
        }
      } finally {
        // Safety net: if anything above threw before a terminal notice was set, do not stay "pending" forever.
        if (deletionNow.current === mine) {
          markUnconfirmed(id, title)
          setDel({ id, title, phase: 'unknown', text: `Could not confirm whether ${quoted(title)} was deleted: something went wrong while handling the server's answer. It may still exist.` })
        }
      }
    })().catch(() => { /* already reported through the notice (or the safety net above); callers await this promise and must not see a rejection */ })
    pendingDelete.current = run.finally(() => { pendingDelete.current = null })
  }

  // An unconfirmed delete is settled by server data: a snapshot that is neither from the cache nor carrying
  // unacknowledged local writes, and that no longer lists the note. (Deletes here are transactions, which cause
  // no optimistic local event, so such a removal came from the server.) Checked whenever the snapshot or the
  // unconfirmed set changes, so it does not matter which of the two arrives first. It waits for a pending
  // delete to answer first, so it never replaces that notice.
  const authoritative = !fromCache && !pendingWrites
  useEffect(() => {
    if (!authoritative || !notes || deletion?.phase === 'pending') return
    const gone = Object.entries(unconfirmed).filter(([id]) => !notes.some((n) => n.id === id))
    if (gone.length === 0) return
    clearUnconfirmed(...gone.map(([id]) => id))
    // A clean editor of a note that is gone closes by itself (and a note that is not open needs nothing).
    // One that still holds unsaved edits stays: it offers the usual choices for a remotely deleted note.
    const h = editor.current
    if (!h || h.state() === 'saved') setSel((s) => (gone.some(([id]) => id === s) ? null : s))
    const titles = gone.map(([, t]) => quoted(t)).join(', ')
    setDel({ id: gone[0][0], title: gone[0][1], phase: 'done', text: `${titles} ${gone.length > 1 ? 'were' : 'was'} deleted (confirmed by the server).` })
  }, [notes, authoritative, deletion, unconfirmed])
  const wrap = (p: Promise<unknown>) => p.catch((e) => setErr(String(e.message ?? e)))

  const current = sel ? notes?.find((n) => n.id === sel) ?? null : null
  // keep the editor mounted (with its draft) if the note vanished remotely
  const [last, setLast] = useState<Note | null>(null)
  useEffect(() => { if (current) setLast(current) }, [current])
  const shown = sel ? (current ?? last) : null
  selNow.current = sel

  // Search runs on the user's own notes already loaded here; it never writes and never touches the open editor.
  const index = useRef(new Map<string, Indexed>())
  const found = useMemo(() => {
    if (!notes) return null
    index.current = indexNotes(notes, index.current)
    return searchNotes(notes, index.current, query)
  }, [notes, query])
  const searching = query.trim() !== ''
  // Unresolved deletes whose notice was dismissed (or replaced by a later one) stay visible.
  const lingering = Object.entries(unconfirmed).filter(([id]) => !(deletion?.phase === 'unknown' && deletion.id === id))

  return (
    <div className="app">
      <header>
        <strong>Online Notes</strong>
        <span>{user.displayName ?? user.email}</span>
        <button ref={settingsButton} aria-expanded={settingsOpen} aria-controls="settings"
          onClick={() => setSettingsOpen((o) => !o)}>Settings</button>
        <button disabled={leaving} onClick={() => void leaveNote(
          'signOut', () => signOut(auth).catch((e) => setErr(String(e.message ?? e))),
        )}>Sign out</button>
      </header>
      {settingsOpen && <Settings prefs={prefs} onClose={() => { setSettingsOpen(false); settingsButton.current?.focus() }} />}
      {(!online || fromCache) && <div className="banner" role="status">Not connected to the server. Changes cannot be saved until you reconnect.</div>}
      {err && <div className="banner err" role="alert">{err}</div>}
      {prefs.problem && !settingsOpen && (
        <div className="banner err" role="alert">{prefs.problem}{' '}
          <button onClick={() => setSettingsOpen(true)}>Open settings</button></div>
      )}
      {deletion && (
        <div className={deletion.phase === 'pending' || deletion.phase === 'done' ? 'banner' : 'banner err'}
          role={deletion.phase === 'pending' || deletion.phase === 'done' ? 'status' : 'alert'}>
          {deletion.text}{' '}
          {deletion.phase !== 'pending' && <button onClick={() => setDel(null)}>Dismiss</button>}
        </div>
      )}
      {deletion?.phase === 'pending' && deferred && (
        <div className="banner err" role="alert">
          Staying on this note: it has unsaved edits that are held until the server answers the delete.
          They are kept. Once it answers you can leave, or resolve them if the delete is refused.
        </div>
      )}
      {lingering.map(([id, title]) => (
        <div key={id} className="banner err" role="status" data-unconfirmed={id}>
          Still unconfirmed: it is not known whether {quoted(title)} was deleted. It may still exist; it leaves the list if it was deleted.
        </div>
      ))}
      <div className="body">
        <nav className="sidebar" aria-label="Notes">
          <button onClick={() => { setQuery(''); void wrap(createNote(db, user.uid).then(select)) }}>+ New note</button>
          <input className="search" type="search" value={query} placeholder="Search notes" aria-label="Search notes"
            onChange={(e) => setQuery(e.target.value)} />
          {notes === null || found === null ? <p>Loading notes…</p>
            : notes.length === 0 ? <p>No notes yet.</p>
            : found.length === 0 ? (
              <p role="status">No notes match {quoted(query.trim())}. <button onClick={() => setQuery('')}>Clear search</button></p>
            ) : (
              <>
                {searching && <p className="count" role="status">{found.length} of {notes.length} {notes.length === 1 ? 'note' : 'notes'}</p>}
                <ul>{found.map((n) => (
                  <li key={n.id}>
                    <button className={n.id === sel ? 'sel' : ''} disabled={leaving} onClick={() => void select(n.id)}>
                      {unconfirmed[n.id] !== undefined && (
                        <span className="flag" title="Delete not confirmed: it may still exist">{'\u26a0'}<span className="sr-only"> delete unconfirmed:</span>{' '}</span>
                      )}
                      {n.title || 'Untitled'}
                    </button>
                  </li>))}</ul>
              </>
            )}
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
