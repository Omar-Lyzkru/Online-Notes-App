import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, deleteDoc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'

let env: RulesTestEnvironment
const valid = (rev = 1) => ({ title: 't', content: '{}', rev, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-notes-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: 'localhost', port: 8080 },
  })
})
afterAll(() => env.cleanup())
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'users/alice/notes/n1'), { ...valid(), createdAt: new Date(), updatedAt: new Date() }))
})

const alice = () => env.authenticatedContext('alice').firestore()
const bob = () => env.authenticatedContext('bob').firestore()
const anon = () => env.unauthenticatedContext().firestore()
const ref = (db: ReturnType<typeof alice>, p = 'users/alice/notes/n1') => doc(db, p)

describe('firestore rules', () => {
  it('denies unauthenticated read/write/delete', async () => {
    await assertFails(getDoc(ref(anon())))
    await assertFails(setDoc(ref(anon(), 'users/alice/notes/n2'), valid()))
    await assertFails(deleteDoc(ref(anon())))
  })
  it('lets the owner read, create, update (rev+1), delete', async () => {
    await assertSucceeds(getDoc(ref(alice())))
    await assertSucceeds(setDoc(ref(alice(), 'users/alice/notes/n2'), valid()))
    await assertSucceeds(updateDoc(ref(alice()), { title: 'x', rev: 2, updatedAt: serverTimestamp() }))
    await assertSucceeds(deleteDoc(ref(alice())))
  })
  it('denies cross-user read, create, update, delete', async () => {
    await assertFails(getDoc(ref(bob())))
    await assertFails(setDoc(ref(bob(), 'users/alice/notes/n2'), valid()))
    await assertFails(updateDoc(ref(bob()), { title: 'x', rev: 2, updatedAt: serverTimestamp() }))
    await assertFails(deleteDoc(ref(bob())))
  })
  it('rejects ownership spoofing via extra fields and other paths', async () => {
    await assertFails(setDoc(ref(bob(), 'users/bob/notes/n2'), { ...valid(), ownerId: 'alice' }))
    await assertFails(setDoc(ref(bob(), 'notes/n2'), valid()))
    await assertFails(setDoc(ref(bob(), 'users/bob/other/n2'), valid()))
  })
  it('rejects stale or skipped revisions and bad shapes', async () => {
    await assertFails(updateDoc(ref(alice()), { rev: 1, updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(ref(alice()), { rev: 3, updatedAt: serverTimestamp() }))
    await assertFails(setDoc(ref(alice(), 'users/alice/notes/n3'), valid(5)))
    await assertFails(setDoc(ref(alice(), 'users/alice/notes/n4'), { ...valid(), title: 5 }))
  })
})
