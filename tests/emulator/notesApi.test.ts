import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { connectFirestoreEmulator, deleteDoc, disableNetwork, doc, enableNetwork, getDoc, getFirestore, runTransaction, type Firestore } from 'firebase/firestore'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { ConflictError, DeleteOutcomeUnknownError, createNote, deleteNote, saveNote, subscribeNotes, type Note } from '../../src/notesApi'
import { provision } from './sessions'

const apps: FirebaseApp[] = []
let uid = ''
async function session(name: string): Promise<Firestore> {
  const app = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, name)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, 'localhost', 8080)
  await signInAnonymously(auth)
  uid = auth.currentUser!.uid
  await provision(uid)
  return db
}
afterAll(() => Promise.all(apps.map(deleteApp)))

const until = <T,>(get: () => T | undefined) => new Promise<T>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => { const v = get(); if (v !== undefined) { clearInterval(i); res(v) } else if (Date.now() - t0 > 8000) { clearInterval(i); rej(new Error('timeout')) } }, 50)
})

describe('notesApi against emulator', () => {
  let a: Firestore
  beforeAll(async () => { a = await session('a') })

  it('creates, saves with rev+1, rejects stale writes, deletes', async () => {
    const id = await createNote(a, uid)
    expect(await saveNote(a, uid, id, { title: 'T', content: '{"x":1}' }, 1)).toBe(2)
    await expect(saveNote(a, uid, id, { title: 'stale', content: '{}' }, 1)).rejects.toBeInstanceOf(ConflictError)
    await deleteNote(a, uid, id, 2)
    await expect(saveNote(a, uid, id, { title: 'x', content: '{}' }, 2)).rejects.toMatchObject({ remote: null })
  })

  it('propagates create, update and delete to a second session of the same user', async () => {
    const authA = getAuth(apps[0])
    const app2 = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, 'b'); apps.push(app2)
    const auth2 = getAuth(app2); connectAuthEmulator(auth2, 'http://localhost:9099', { disableWarnings: true })
    const b = getFirestore(app2); connectFirestoreEmulator(b, 'localhost', 8080)
    // The Auth emulator accepts unsigned custom tokens, giving a second session for the same uid.
    const { signInWithCustomToken } = await import('firebase/auth')
    const token = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ uid: authA.currentUser!.uid, aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit', iss: 'x', sub: 'x', iat: 0, exp: 9999999999 })).toString('base64url') + '.'
    await signInWithCustomToken(auth2, token)
    expect(auth2.currentUser!.uid).toBe(uid)

    let seen: Note[] = []
    const stop = subscribeNotes(b, uid, (n) => (seen = n), (e) => { throw e })
    const id = await createNote(a, uid)
    await until(() => seen.find((n) => n.id === id))
    await saveNote(a, uid, id, { title: 'synced', content: '{}' }, 1)
    await until(() => seen.find((n) => n.id === id && n.title === 'synced'))
    await deleteNote(a, uid, id, 2)
    await until(() => (seen.some((n) => n.id === id) ? undefined : true))
    stop()
  })
})

/** A second session (own app instance) signed in as the same user, or as a different one. */
async function sessionAs(name: string, sameUidAs?: string): Promise<{ db: Firestore; uid: string }> {
  const app = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, name); apps.push(app)
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  const db = getFirestore(app); connectFirestoreEmulator(db, 'localhost', 8080)
  if (sameUidAs) {
    const { signInWithCustomToken } = await import('firebase/auth')
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    await signInWithCustomToken(auth, enc({ alg: 'none', typ: 'JWT' }) + '.' + enc({ uid: sameUidAs, aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit', iss: 'x', sub: 'x', iat: 0, exp: 9999999999 }) + '.')
  } else { await signInAnonymously(auth); await provision(auth.currentUser!.uid) }
  return { db, uid: auth.currentUser!.uid }
}
const exists = async (db: Firestore, uid: string, id: string) => (await getDoc(doc(db, 'users', uid, 'notes', id))).exists()

describe('revision-aware deletion against the emulator', () => {
  let a: Firestore, b: Firestore, owner = ''
  beforeAll(async () => {
    ;({ db: a, uid: owner } = await sessionAs('del-a'))
    ;({ db: b } = await sessionAs('del-b', owner)) // the same user in a second session
  })

  it('deletes when the expected revision matches and reports it only after the server acknowledged', async () => {
    const id = await createNote(a, owner)
    await saveNote(a, owner, id, { title: 'T', content: '{}' }, 1)
    await expect(deleteNote(a, owner, id, 2)).resolves.toBe('deleted')
    expect(await exists(b, owner, id)).toBe(false) // another session already sees it gone
  })

  it('refuses a stale revision, and the newer content survives', async () => {
    const id = await createNote(a, owner)                                               // R1 seen by session A
    await saveNote(b, owner, id, { title: 'newer', content: '{"n":1}' }, 1)              // session B writes R2
    const err = await deleteNote(a, owner, id, 1).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.remote).toMatchObject({ id, rev: 2, title: 'newer', content: '{"n":1}' })
    const snap = await getDoc(doc(a, 'users', owner, 'notes', id))
    expect(snap.data()).toMatchObject({ rev: 2, title: 'newer', content: '{"n":1}' })
    await deleteNote(a, owner, id, 2)
  })

  it('needs a fresh expected revision to delete after a refusal, and is refused again if the note moved again', async () => {
    const id = await createNote(a, owner)
    await saveNote(b, owner, id, { title: 'r2', content: '{}' }, 1)                      // R2
    await expect(deleteNote(a, owner, id, 1)).rejects.toBeInstanceOf(ConflictError)      // refused; user reviews R2
    await saveNote(b, owner, id, { title: 'r3', content: '{}' }, 2)                      // R3 lands before the user re-confirms
    const again = await deleteNote(a, owner, id, 2).then(() => null, (e) => e)           // re-confirmed on R2
    expect(again).toBeInstanceOf(ConflictError); expect(again.remote.rev).toBe(3)
    expect(await exists(a, owner, id)).toBe(true)
    await expect(deleteNote(a, owner, id, 3)).resolves.toBe('deleted')                   // confirmed on what is current
    expect(await exists(a, owner, id)).toBe(false)
  })

  it('an already-deleted note is a harmless no-op, and null expects absence', async () => {
    const id = await createNote(a, owner)
    await deleteNote(a, owner, id, 1)
    await expect(deleteNote(b, owner, id, 1)).resolves.toBe('already-deleted')
    const id2 = await createNote(a, owner)
    await expect(deleteNote(a, owner, id2, null)).rejects.toBeInstanceOf(ConflictError) // it exists, so null is wrong
    expect(await exists(a, owner, id2)).toBe(true)
  })

  it("another user cannot delete the owner's note, even with the right revision", async () => {
    const { db: mallory } = await sessionAs('del-mallory')
    const id = await createNote(a, owner)
    const err = await deleteNote(mallory, owner, id, 1).then(() => null, (e) => e)
    expect(err).not.toBeNull(); expect(err.code).toBe('permission-denied')
    expect(await exists(a, owner, id)).toBe(true)
  })

  it('races: a delete and a save based on the same revision never both win, and a saved revision is never deleted unseen', async () => {
    const tallies = { deleted: 0, saved: 0 }
    const after = <T,>(ms: number, f: () => Promise<T>) => new Promise((r) => setTimeout(r, ms)).then(f)
    for (let i = 0; i < 40; i++) {
      const id = await createNote(a, owner)
      const lag = (i % 8) * 6, deleteFirst = i % 2 === 0 // stagger the start so the race window is hit from both sides
      const [del, sav] = await Promise.allSettled([
        after(deleteFirst ? 0 : lag, () => deleteNote(a, owner, id, 1)),
        after(deleteFirst ? lag : 0, () => saveNote(b, owner, id, { title: 'concurrent', content: '{}' }, 1)),
      ])
      const present = await exists(a, owner, id)
      if (del.status === 'fulfilled' && del.value === 'deleted') {
        expect(sav.status).toBe('rejected'); expect(present).toBe(false); tallies.deleted++
      } else {
        expect(sav.status).toBe('fulfilled'); expect(present).toBe(true)
        expect(del.status === 'rejected' && del.reason).toBeInstanceOf(ConflictError)
        expect((await getDoc(doc(a, 'users', owner, 'notes', id))).data()).toMatchObject({ rev: 2, title: 'concurrent' })
        tallies.saved++
      }
    }
    console.log('race outcomes (40 rounds):', tallies)
  }, 60000)

  it('atomicity: a write landing between the transaction\'s read and its delete forces a re-read, so the stale delete cannot commit', async () => {
    // The exact window deleteNote relies on, forced deterministically: session B saves R2 while A's
    // transaction has read R1 but not yet deleted.
    const id = await createNote(a, owner)
    const ref = doc(a, 'users', owner, 'notes', id)
    const seen: number[] = []
    let interfered = false
    const outcome = await runTransaction(a, async (tx) => {
      const snap = await tx.get(ref)
      seen.push(snap.data()!.rev)
      if (!interfered) { interfered = true; await saveNote(b, owner, id, { title: 'landed in between', content: '{}' }, 1) }
      if (snap.data()!.rev !== 1) return 'rev moved'
      tx.delete(ref)
      return 'deleted'
    })
    expect(seen).toEqual([1, 2])          // the callback re-ran against the new revision
    expect(outcome).toBe('rev moved')     // the delete based on R1 never committed
    expect(await exists(a, owner, id)).toBe(true)
  }, 20000)

  it('a server that cannot be reached is a failure, never a success, and nothing is deleted', async () => {
    const id = await createNote(a, owner)
    const app = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, 'del-unreachable'); apps.push(app)
    const dead = getFirestore(app); connectFirestoreEmulator(dead, 'localhost', 1)
    const err = await deleteNote(dead, owner, id, 1).then(() => null, (e) => e)
    expect(err).not.toBeNull(); expect(err).not.toBeInstanceOf(DeleteOutcomeUnknownError) // it never got as far as sending the delete
    expect(await exists(a, owner, id)).toBe(true)
  }, 40000) // the SDK takes ~10 s to conclude it is offline; until then the UI correctly shows the delete as pending
})

describe('listener snapshots: local optimistic changes versus server confirmation', () => {
  type Ev = { gone: boolean; cache: boolean; pending: boolean }
  const authoritativeGone = (e: Ev) => e.gone && !e.cache && !e.pending // what the app treats as server-confirmed
  const watch = (db: Firestore, uid: string, id: string) => {
    const events: Ev[] = []
    const stop = subscribeNotes(db, uid, (n, cache, pending) => events.push({ gone: !n.some((x) => x.id === id), cache, pending }), (e) => { throw e })
    return { events, stop }
  }

  it('characterization: an online bare deleteDoc is NOT distinguishable in the snapshot metadata — which is why the app never issues one', async () => {
    const { db, uid } = await sessionAs('opt-online')
    const id = await createNote(db, uid)
    const { events, stop } = watch(db, uid, id)
    await until(() => events.some((e) => !e.gone && !e.cache && !e.pending) || undefined)
    await deleteDoc(doc(db, 'users', uid, 'notes', id))
    await until(() => events.find((e) => e.gone))
    // hasPendingWrites describes the documents that are IN the snapshot; a locally deleted one is no longer there
    expect(events.find((e) => e.gone)).toMatchObject({ cache: false, pending: false })
    stop()
  })

  it('offline, a local delete disappears from the snapshot flagged fromCache, and is not authoritative until the connection is back', async () => {
    const { db, uid } = await sessionAs('opt-offline')
    const id = await createNote(db, uid)
    const { events, stop } = watch(db, uid, id)
    await until(() => events.some((e) => !e.gone && !e.cache && !e.pending) || undefined)
    await disableNetwork(db)
    const p = deleteDoc(doc(db, 'users', uid, 'notes', id))
    await until(() => events.find((e) => e.gone))                      // gone locally ...
    await new Promise((r) => setTimeout(r, 500))
    expect(events.find((e) => e.gone)).toMatchObject({ cache: true })
    expect(events.some(authoritativeGone)).toBe(false)                 // ... but nothing authoritative
    await enableNetwork(db); await p
    await until(() => events.find(authoritativeGone))
    stop()
  }, 20000)

  it("the app's own transactional delete causes no optimistic event: the first disappearance is already authoritative", async () => {
    const { db, uid } = await sessionAs('opt-tx')
    const id = await createNote(db, uid)
    const { events, stop } = watch(db, uid, id)
    await until(() => events.some((e) => !e.gone && !e.cache && !e.pending) || undefined)
    await deleteNote(db, uid, id, 1)
    await until(() => events.find((e) => e.gone))
    expect(events.find((e) => e.gone)).toMatchObject({ cache: false, pending: false })
    stop()
  })
})
