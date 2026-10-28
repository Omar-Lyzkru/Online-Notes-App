import { afterAll, beforeAll, describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, setDoc, serverTimestamp } from 'firebase/firestore'

// ops/lockdown is the prepared "known-good restrictive" ruleset for a failed rules deployment: it must deny everyone.
let env: RulesTestEnvironment
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-notes-lockdown',
    firestore: { rules: readFileSync('ops/lockdown/firestore.rules', 'utf8'), host: 'localhost', port: 8080 },
  })
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'authorizedUsers/alice'), { active: true })
    await setDoc(doc(c.firestore(), 'users/alice/notes/n1'), { title: 't', content: '{}', rev: 1, createdAt: new Date(), updatedAt: new Date() })
  })
})
afterAll(() => env.cleanup())

describe('lockdown rules', () => {
  it('deny everyone: the approved owner, other users and signed-out requests, for notes, preferences and the allowlist', async () => {
    const note = { title: 't', content: '{}', rev: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    for (const db of [env.authenticatedContext('alice').firestore(), env.authenticatedContext('mallory').firestore(), env.unauthenticatedContext().firestore()]) {
      await assertFails(getDoc(doc(db, 'users/alice/notes/n1')))
      await assertFails(getDocs(collection(db, 'users/alice/notes')))
      await assertFails(setDoc(doc(db, 'users/alice/notes/n2'), note))
      await assertFails(getDoc(doc(db, 'users/alice/preferences/appearance')))
      await assertFails(getDoc(doc(db, 'authorizedUsers/alice')))
      await assertFails(setDoc(doc(db, 'authorizedUsers/mallory'), { active: true }))
    }
  })
})
