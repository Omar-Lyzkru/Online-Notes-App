import { doc, onSnapshot, runTransaction, serverTimestamp, type Firestore } from 'firebase/firestore'
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance } from './appearance'

/** One document per user, readable and writable only by that user (see firestore.rules). */
const prefsRef = (db: Firestore, uid: string) => doc(db, 'users', uid, 'preferences', 'appearance')

/**
 * Saves the changed fields on top of what the server currently has, in a transaction: like note saves it
 * needs the server, so offline it fails visibly instead of queueing, and it resolves only after the server
 * acknowledged it. Fields that were not changed keep whatever another session stored (concurrent changes to
 * different fields both survive; for the same field the later write wins, which is what a setting is).
 */
export async function savePreferences(db: Firestore, uid: string, patch: Partial<Appearance>): Promise<void> {
  const ref = prefsRef(db, uid)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const next = { ...(snap.exists() ? parseAppearance(snap.data()) : DEFAULT_APPEARANCE), ...patch }
    tx.set(ref, { ...next, updatedAt: serverTimestamp() })
  })
}

/**
 * `onData` gets the stored preferences (defaults when the document is missing) and whether the snapshot is
 * only from the local cache, i.e. not confirmed by the server.
 */
export function subscribePreferences(
  db: Firestore, uid: string,
  onData: (a: Appearance, fromCache: boolean) => void, onError: (e: Error) => void,
): () => void {
  return onSnapshot(prefsRef(db, uid), { includeMetadataChanges: true },
    (snap) => onData(parseAppearance(snap.exists() ? snap.data() : undefined), snap.metadata.fromCache), onError)
}
