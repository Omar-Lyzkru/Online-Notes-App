import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { ConflictError, createNote, deleteNote, saveNote } from '../../src/notesApi'
import { closeSessions, session } from './sessions'

/**
 * Investigation of the documented limitation "a modified client of the same owner can bypass the
 * revision-aware delete". These tests pin down exactly where the boundary is, with the repository's real rules,
 * and (last block) what a stricter rules design would and would not change. Nothing here changes the app.
 */
afterAll(closeSessions)

describe('deletion boundary with the repository rules (same owner)', () => {
  it('the supported app path is protected: a delete on a stale revision deletes nothing', async () => {
    const a = await session(), b = await session(a.uid)
    const id = await createNote(a.db, a.uid)
    await saveNote(b.db, a.uid, id, { title: 'newer content', content: '{}' }, 1)           // another session moves on to rev 2
    await expect(deleteNote(a.db, a.uid, id, 1)).rejects.toBeInstanceOf(ConflictError)
    expect((await getDoc(doc(a.db, 'users', a.uid, 'notes', id))).data()).toMatchObject({ rev: 2, title: 'newer content' })
  })

  it('BYPASS: a modified client of the same owner can delete a note at any revision with a bare deleteDoc', async () => {
    const a = await session(), b = await session(a.uid)
    const id = await createNote(a.db, a.uid)
    await saveNote(b.db, a.uid, id, { title: 'newer content the other client never saw', content: '{}' }, 1)
    // no revision check exists for deletes in the rules: the SDK call below is accepted
    await deleteDoc(doc(a.db, 'users', a.uid, 'notes', id))
    expect((await getDoc(doc(b.db, 'users', a.uid, 'notes', id))).exists()).toBe(false)
  })

  it('writes are enforced by the rules, though: a stale or skipped revision from any client of the owner is rejected', async () => {
    const a = await session()
    const id = await createNote(a.db, a.uid)
    const ref = doc(a.db, 'users', a.uid, 'notes', id)
    await saveNote(a.db, a.uid, id, { title: 'v2', content: '{}' }, 1)
    await expect(updateDoc(ref, { title: 'stale overwrite', content: '{}', rev: 2, updatedAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(updateDoc(ref, { title: 'skip', content: '{}', rev: 9, updatedAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await getDoc(ref)).data()).toMatchObject({ rev: 2, title: 'v2' })
  })

  it('...but a revision check cannot tell an informed write from a blind one: a modified client that reads the current rev can overwrite anything', async () => {
    const a = await session(), b = await session(a.uid)
    const id = await createNote(a.db, a.uid)
    await saveNote(b.db, a.uid, id, { title: 'newer content', content: '{"n":1}' }, 1)
    const ref = doc(a.db, 'users', a.uid, 'notes', id)
    const cur = (await getDoc(ref)).data()!                                                  // the modified client simply reads first ...
    await updateDoc(ref, { title: 'blind overwrite', content: '{}', rev: cur.rev + 1, updatedAt: serverTimestamp() })   // ... and its write is protocol-correct
    expect((await getDoc(ref)).data()).toMatchObject({ rev: 3, title: 'blind overwrite' })
  })

  it('a different user can do none of this', async () => {
    const owner = await session(), mallory = await session()
    const id = await createNote(owner.db, owner.uid)
    await expect(deleteDoc(doc(mallory.db, 'users', owner.uid, 'notes', id))).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await getDoc(doc(owner.db, 'users', owner.uid, 'notes', id))).exists()).toBe(true)
  })
})

describe('what a stricter rules design could enforce (candidate rules, evaluated here only; the repository rules are unchanged)', () => {
  // Candidate: a note may be deleted only after an acknowledged update (rev + 1, so a compare-and-set on the
  // current revision) marked it `deleted: true`. Bare deleteDoc on a live note is then refused by the rules.
  const candidate = readFileSync('firestore.rules', 'utf8')
    .replace("hasOnly(['title', 'content', 'rev', 'createdAt', 'updatedAt'])", "hasOnly(['title', 'content', 'rev', 'createdAt', 'updatedAt', 'deleted'])")
    .replace('allow read, delete: if isOwner(uid);', 'allow read: if isOwner(uid);\n      allow delete: if isOwner(uid) && resource.data.get(\'deleted\', false) == true;')
  let env: RulesTestEnvironment
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'demo-notes-candidate', firestore: { rules: candidate, host: 'localhost', port: 8080 } })
    await env.clearFirestore()
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'authorizedUsers/alice'), { active: true }))
  })
  afterAll(() => env.cleanup())
  const seed = (rev: number, extra: object = {}) => env.withSecurityRulesDisabled((c) =>
    setDoc(doc(c.firestore(), 'users/alice/notes/n1'), { title: 't', content: '{}', rev, createdAt: new Date(), updatedAt: new Date(), ...extra }))
  const alice = () => env.authenticatedContext('alice').firestore()
  const ref = () => doc(alice(), 'users/alice/notes/n1')

  it('a bare deleteDoc on a live note is refused', async () => {
    await seed(1)
    await assertFails(deleteDoc(ref()))
  })
  it('a delete after a tombstone update is accepted, and the tombstone update itself must carry the current revision + 1', async () => {
    await seed(2)
    await assertFails(updateDoc(ref(), { deleted: true, rev: 2, updatedAt: serverTimestamp() }))      // stale base: refused
    await assertSucceeds(updateDoc(ref(), { deleted: true, rev: 3, updatedAt: serverTimestamp() }))
    await assertSucceeds(deleteDoc(ref()))
  })
  it('still no protection against a modified client of the owner: it reads the current rev, tombstones, deletes', async () => {
    await seed(5, {})
    const cur = (await getDoc(ref())).data()!
    await assertSucceeds(updateDoc(ref(), { deleted: true, rev: cur.rev + 1, updatedAt: serverTimestamp() }))
    await assertSucceeds(deleteDoc(ref()))
  })
})
