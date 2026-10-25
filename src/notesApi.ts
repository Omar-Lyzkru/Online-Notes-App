import {
  collection, doc, onSnapshot, runTransaction, serverTimestamp, setDoc,
  Timestamp, type Firestore,
} from 'firebase/firestore'

export interface Draft { title: string; content: string }
/** content is a JSON string of the Tiptap document (never HTML). */
export interface Note extends Draft { id: string; rev: number; updatedAt: number }

/** The stored note moved on (remote is its current state) or was deleted (remote is null). */
export class ConflictError extends Error {
  constructor(public remote: Note | null) { super(remote ? 'stale revision' : 'note deleted remotely') }
}

export const EMPTY_DOC = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })

const notesCol = (db: Firestore, uid: string) => collection(db, 'users', uid, 'notes')
const noteRef = (db: Firestore, uid: string, id: string) => doc(db, 'users', uid, 'notes', id)

function toNote(id: string, d: Record<string, any>): Note {
  const t: Timestamp | null = d.updatedAt
  return { id, title: d.title, content: d.content, rev: d.rev, updatedAt: t ? t.toMillis() : Date.now() }
}

/** Resolves only after the server acknowledged the write. */
export async function createNote(db: Firestore, uid: string): Promise<string> {
  const ref = doc(notesCol(db, uid))
  await setDoc(ref, {
    title: '', content: EMPTY_DOC, rev: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
  return ref.id
}

/**
 * Saves draft on top of baseRev inside a transaction (server round trip, so it fails when offline
 * instead of queueing). baseRev === null recreates a note that was deleted remotely.
 * Returns the new revision. Firestore rules additionally reject any write that is not rev + 1.
 */
export async function saveNote(db: Firestore, uid: string, id: string, draft: Draft, baseRev: number | null): Promise<number> {
  const ref = noteRef(db, uid, id)
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (baseRev === null) {
      if (snap.exists()) throw new ConflictError(toNote(id, snap.data()))
      tx.set(ref, { ...draft, rev: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      return 1
    }
    if (!snap.exists()) throw new ConflictError(null)
    const cur = snap.data()
    if (cur.rev !== baseRev) throw new ConflictError(toNote(id, cur))
    tx.update(ref, { ...draft, rev: baseRev + 1, createdAt: cur.createdAt, updatedAt: serverTimestamp() })
    return baseRev + 1
  })
}

/**
 * The request to delete may or may not have been applied: the connection failed or timed out after the
 * delete was handed to the server. The note could be gone or still there.
 */
export class DeleteOutcomeUnknownError extends Error {
  constructor(public cause: unknown) { super('delete outcome unknown') }
}

/** Errors that mean the server refused or never committed the transaction (as opposed to "no answer"). */
const NOT_APPLIED = new Set([
  'permission-denied', 'unauthenticated', 'failed-precondition', 'invalid-argument', 'aborted',
  'not-found', 'already-exists', 'resource-exhausted', 'out-of-range', 'unimplemented',
])

/**
 * Deletes a note only if it is still at `expectedRev`, the revision the user was looking at. The read and
 * the delete are one transaction (committed with a precondition on the document that was read), so a
 * write that lands in between makes the commit retry and fail the check instead of being deleted unseen.
 * `expectedRev === null` expects the note to be absent. Resolves only after the server acknowledged it:
 *  - 'deleted'          the note was at expectedRev and is gone
 *  - 'already-deleted'  it was already gone (deleted elsewhere); nothing left to do
 * Rejects with ConflictError(remote) when the note moved on (nothing is deleted), with
 * DeleteOutcomeUnknownError when the connection failed after a delete had been sent to the server (the
 * SDK retries a transaction on connection errors, so an earlier attempt may have been applied even if
 * the last one failed before sending), and with the Firestore error otherwise (not deleted, e.g.
 * offline from the start or permission denied).
 */
export async function deleteNote(
  db: Firestore, uid: string, id: string, expectedRev: number | null,
): Promise<'deleted' | 'already-deleted'> {
  const ref = noteRef(db, uid, id)
  let everSent = false // sticky: the transaction callback re-runs on retries, and any attempt may have committed
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists()) return 'already-deleted' as const
      if (expectedRev === null || snap.data().rev !== expectedRev) throw new ConflictError(toNote(id, snap.data()))
      tx.delete(ref)
      everSent = true
      return 'deleted' as const
    })
  } catch (e) {
    if (e instanceof ConflictError) throw e // an observation of the server's state, however many attempts came before
    const code = (e as { code?: string }).code
    if (everSent && !(code && NOT_APPLIED.has(code))) throw new DeleteOutcomeUnknownError(e)
    throw e
  }
}

/**
 * `fromCache`: the data did not come from the server (e.g. offline, or a local change applied to the cache).
 * `hasPendingWrites`: the documents in it include local writes the server has not acknowledged.
 * A note missing from a snapshot with both false was removed by the server — provided the app issues no bare
 * local deletes, which it does not (deletes are transactions, and a transaction produces no optimistic
 * event). The flags cannot tell an online bare `deleteDoc` from a server event (see the emulator tests).
 */
export function subscribeNotes(
  db: Firestore, uid: string,
  onData: (notes: Note[], fromCache: boolean, hasPendingWrites: boolean) => void, onError: (e: Error) => void,
): () => void {
  return onSnapshot(notesCol(db, uid), { includeMetadataChanges: true }, (snap) => {
    const notes = snap.docs.map((d) => toNote(d.id, d.data({ serverTimestamps: 'estimate' })))
    onData(notes.sort((a, b) => b.updatedAt - a.updatedAt), snap.metadata.fromCache, snap.metadata.hasPendingWrites)
  }, onError)
}
