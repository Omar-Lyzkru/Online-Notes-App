import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, deleteDoc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { BACKGROUNDS, FONT_SIZES, THEMES } from '../../src/appearance'

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

describe('firestore rules — appearance preferences', () => {
  const P = 'users/alice/preferences/appearance'
  const prefs = (o: Record<string, unknown> = {}) => ({ theme: 'dark', background: 'plain', fontSize: 'medium', updatedAt: serverTimestamp(), ...o })

  it('lets the owner create, read and update their own preferences', async () => {
    await assertSucceeds(setDoc(ref(alice(), P), prefs()))
    await assertSucceeds(getDoc(ref(alice(), P)))
    await assertSucceeds(setDoc(ref(alice(), P), prefs({ theme: 'light', fontSize: 'xlarge' })))
    await assertSucceeds(updateDoc(ref(alice(), P), { background: 'rose', updatedAt: serverTimestamp() }))
  })
  it('accepts every preset the app offers and nothing else', async () => {
    for (const t of THEMES) await assertSucceeds(setDoc(ref(alice(), P), prefs({ theme: t.id })))
    for (const b of BACKGROUNDS) await assertSucceeds(setDoc(ref(alice(), P), prefs({ background: b.id })))
    for (const f of FONT_SIZES) await assertSucceeds(setDoc(ref(alice(), P), prefs({ fontSize: f.id })))
    await assertFails(setDoc(ref(alice(), P), prefs({ theme: 'sepia' })))
    await assertFails(setDoc(ref(alice(), P), prefs({ background: '#ff0000' })))
    await assertFails(setDoc(ref(alice(), P), prefs({ fontSize: 'huge' })))
    await assertFails(setDoc(ref(alice(), P), prefs({ fontSize: 16 })))
  })
  it('rejects missing fields, extra fields and a client-chosen timestamp', async () => {
    await assertFails(setDoc(ref(alice(), P), { theme: 'dark', background: 'plain', updatedAt: serverTimestamp() }))
    await assertFails(setDoc(ref(alice(), P), prefs({ css: 'body{display:none}' })))
    await assertFails(setDoc(ref(alice(), P), prefs({ updatedAt: new Date() })))
    await assertFails(setDoc(ref(alice(), P), { theme: 'dark', background: 'plain', fontSize: 'medium' }))
  })
  it('keeps one user out of another user\'s preferences: read, create, update', async () => {
    await assertSucceeds(setDoc(ref(alice(), P), prefs()))
    await assertFails(getDoc(ref(bob(), P)))
    await assertFails(setDoc(ref(bob(), P), prefs({ theme: 'light' })))
    await assertFails(updateDoc(ref(bob(), P), { theme: 'light', updatedAt: serverTimestamp() }))
    await assertFails(setDoc(ref(bob(), 'users/alice/preferences/other'), prefs()))
  })
  it('denies unauthenticated access', async () => {
    await assertSucceeds(setDoc(ref(alice(), P), prefs()))
    await assertFails(getDoc(ref(anon(), P)))
    await assertFails(setDoc(ref(anon(), P), prefs()))
  })
  it('allows no other path for preferences and does not allow deleting them', async () => {
    await assertFails(setDoc(ref(alice(), 'users/alice/preferences/other'), prefs()))
    await assertFails(setDoc(ref(alice(), 'users/alice/settings/appearance'), prefs()))
    await assertSucceeds(setDoc(ref(alice(), P), prefs()))
    await assertFails(deleteDoc(ref(alice(), P)))
  })
  it('does not change what the notes rules allow (a preferences write cannot touch a note and vice versa)', async () => {
    await assertFails(setDoc(ref(alice(), 'users/alice/notes/n9'), prefs()))
    await assertFails(setDoc(ref(alice(), P), valid()))
  })
})
