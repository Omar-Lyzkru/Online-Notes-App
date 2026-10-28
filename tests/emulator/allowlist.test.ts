import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, serverTimestamp, type Firestore,
} from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import { createNote, deleteNote, saveNote, subscribeNotes } from '../../src/notesApi'
import { savePreferences, subscribePreferences } from '../../src/preferencesApi'
import { closeSessions, deprovision, provision, session, unapprovedSession } from './sessions'

/**
 * The personal-only gate: a signed-in user reaches notes and preferences only when a membership document
 * `authorizedUsers/{uid}` with `active == true` exists, AND the path's uid is theirs. The first block drives the
 * repository's real rules through the rules test harness; the second uses the real Firebase SDK signed in
 * through the Auth emulator (the same code path as the app); the third sends raw REST requests with an Auth
 * emulator ID token (no SDK at all). The membership documents are written only with privileged access.
 */

const valid = (rev = 1) => ({ title: 't', content: '{}', rev, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
const prefs = (o: Record<string, unknown> = {}) => ({ theme: 'dark', background: 'plain', fontSize: 'medium', updatedAt: serverTimestamp(), ...o })

describe('allowlist rules', () => {
  let env: RulesTestEnvironment
  const member = (uid: string, data: Record<string, unknown> = { active: true }) =>
    env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), `authorizedUsers/${uid}`), data))
  const seedNote = (uid: string) => env.withSecurityRulesDisabled((c) =>
    setDoc(doc(c.firestore(), `users/${uid}/notes/n1`), { ...valid(), createdAt: new Date(), updatedAt: new Date() }))
  const ctx = (uid: string) => env.authenticatedContext(uid).firestore()
  const anon = () => env.unauthenticatedContext().firestore()

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-notes-allowlist',
      firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: 'localhost', port: 8080 },
    })
  })
  afterAll(() => env.cleanup())
  beforeEach(async () => {
    await env.clearFirestore()
    await member('alice'); await member('bob')
    await seedNote('alice'); await seedNote('mallory')   // mallory has a note document but no membership: it must stay unreachable
  })

  describe('the approved uid keeps everything it had', () => {
    it('reads its own notes (get and list)', async () => {
      await assertSucceeds(getDoc(doc(ctx('alice'), 'users/alice/notes/n1')))
      await assertSucceeds(getDocs(collection(ctx('alice'), 'users/alice/notes')))
    })
    it('creates, edits (rev + 1) and deletes its own notes', async () => {
      const d = ctx('alice')
      await assertSucceeds(setDoc(doc(d, 'users/alice/notes/n2'), valid()))
      await assertSucceeds(updateDoc(doc(d, 'users/alice/notes/n2'), { title: 'x', rev: 2, updatedAt: serverTimestamp() }))
      await assertSucceeds(deleteDoc(doc(d, 'users/alice/notes/n2')))
    })
    it('reads and writes its own appearance preferences', async () => {
      const p = doc(ctx('alice'), 'users/alice/preferences/appearance')
      await assertSucceeds(setDoc(p, prefs()))
      await assertSucceeds(getDoc(p))
      await assertSucceeds(updateDoc(p, { theme: 'light', updatedAt: serverTimestamp() }))
    })
    it('is still held to the note and preference validation', async () => {
      const d = ctx('alice')
      await assertFails(updateDoc(doc(d, 'users/alice/notes/n1'), { rev: 1, updatedAt: serverTimestamp() }))      // stale
      await assertFails(updateDoc(doc(d, 'users/alice/notes/n1'), { rev: 3, updatedAt: serverTimestamp() }))      // skipped
      await assertFails(setDoc(doc(d, 'users/alice/notes/n3'), { ...valid(), ownerId: 'bob' }))                   // extra field
      await assertFails(setDoc(doc(d, 'users/alice/notes/n4'), valid(2)))                                         // create must be rev 1
      await assertFails(setDoc(doc(d, 'users/alice/preferences/appearance'), prefs({ theme: 'sepia' })))
      await assertFails(setDoc(doc(d, 'users/alice/preferences/appearance'), prefs({ updatedAt: new Date() })))
      await setDoc(doc(d, 'users/alice/preferences/appearance'), prefs())
      await assertFails(deleteDoc(doc(d, 'users/alice/preferences/appearance')))                                  // preferences are never deleted
    })
    it('cannot reach another approved user\'s data: the path must be its own as well', async () => {
      await assertFails(getDoc(doc(ctx('bob'), 'users/alice/notes/n1')))
      await assertFails(getDocs(collection(ctx('bob'), 'users/alice/notes')))
      await assertFails(setDoc(doc(ctx('bob'), 'users/alice/notes/n2'), valid()))
      await assertFails(updateDoc(doc(ctx('bob'), 'users/alice/notes/n1'), { rev: 2, updatedAt: serverTimestamp() }))
      await assertFails(deleteDoc(doc(ctx('bob'), 'users/alice/notes/n1')))
      await assertFails(getDoc(doc(ctx('bob'), 'users/alice/preferences/appearance')))
      await assertFails(setDoc(doc(ctx('bob'), 'users/alice/preferences/appearance'), prefs()))
    })
  })

  describe('an authenticated uid that is not allowlisted', () => {
    it('cannot read or write the approved user\'s data', async () => {
      const m = ctx('mallory')
      await assertFails(getDoc(doc(m, 'users/alice/notes/n1')))
      await assertFails(getDocs(collection(m, 'users/alice/notes')))
      await assertFails(setDoc(doc(m, 'users/alice/notes/n2'), valid()))
      await assertFails(updateDoc(doc(m, 'users/alice/notes/n1'), { rev: 2, updatedAt: serverTimestamp() }))
      await assertFails(deleteDoc(doc(m, 'users/alice/notes/n1')))
      await assertFails(getDoc(doc(m, 'users/alice/preferences/appearance')))
      await assertFails(setDoc(doc(m, 'users/alice/preferences/appearance'), prefs()))
    })
    it('cannot read or write notes under its own uid (including a note that already exists there)', async () => {
      const m = ctx('mallory')
      await assertFails(getDoc(doc(m, 'users/mallory/notes/n1')))
      await assertFails(getDocs(collection(m, 'users/mallory/notes')))
      await assertFails(setDoc(doc(m, 'users/mallory/notes/n2'), valid()))
      await assertFails(updateDoc(doc(m, 'users/mallory/notes/n1'), { rev: 2, updatedAt: serverTimestamp() }))
      await assertFails(deleteDoc(doc(m, 'users/mallory/notes/n1')))
    })
    it('cannot read or write preferences under its own uid', async () => {
      const m = ctx('mallory')
      await assertFails(getDoc(doc(m, 'users/mallory/preferences/appearance')))
      await assertFails(setDoc(doc(m, 'users/mallory/preferences/appearance'), prefs()))
      await assertFails(updateDoc(doc(m, 'users/mallory/preferences/appearance'), { theme: 'light', updatedAt: serverTimestamp() }))
    })
  })

  it('denies unauthenticated requests, including to the allowlist itself', async () => {
    await assertFails(getDoc(doc(anon(), 'users/alice/notes/n1')))
    await assertFails(getDocs(collection(anon(), 'users/alice/notes')))
    await assertFails(setDoc(doc(anon(), 'users/alice/notes/n2'), valid()))
    await assertFails(getDoc(doc(anon(), 'users/alice/preferences/appearance')))
    await assertFails(getDoc(doc(anon(), 'authorizedUsers/alice')))
    await assertFails(setDoc(doc(anon(), 'authorizedUsers/mallory'), { active: true }))
  })

  describe('ordinary clients cannot touch the allowlist', () => {
    it('neither an unapproved nor an approved user can read, list, create, change or delete membership', async () => {
      for (const uid of ['mallory', 'alice']) {
        const d = ctx(uid)
        await assertFails(getDoc(doc(d, 'authorizedUsers/alice')))                       // not even one's own
        await assertFails(getDoc(doc(d, `authorizedUsers/${uid}`)))
        await assertFails(getDocs(collection(d, 'authorizedUsers')))
        await assertFails(setDoc(doc(d, 'authorizedUsers/mallory'), { active: true }))   // self-add
        await assertFails(setDoc(doc(d, 'authorizedUsers/zed'), { active: true }))       // add someone else
        await assertFails(updateDoc(doc(d, 'authorizedUsers/alice'), { active: false }))
        await assertFails(setDoc(doc(d, 'authorizedUsers/alice'), { active: true }))     // replace
        await assertFails(deleteDoc(doc(d, 'authorizedUsers/alice')))
      }
    })
    it('cannot be smuggled through a batch, or a document elsewhere that the check might read', async () => {
      const m = ctx('mallory')
      const batch = writeBatch(m)
      batch.set(doc(m, 'authorizedUsers/mallory'), { active: true })
      batch.set(doc(m, 'users/mallory/notes/n9'), valid())
      await assertFails(batch.commit())
      await assertFails(setDoc(doc(m, 'users/mallory/authorizedUsers/mallory'), { active: true }))
      await assertFails(setDoc(doc(m, 'users/mallory/preferences/authorizedUsers'), { active: true }))
      await assertFails(setDoc(doc(m, 'allowlist/mallory'), { active: true }))
      await assertFails(setDoc(doc(m, 'users/mallory'), { active: true }))
      // and after all of that, still nothing
      await assertFails(getDoc(doc(m, 'users/mallory/notes/n1')))
    })
    it('privileged access (what the console and Admin credentials have) is the only way in, and it works', async () => {
      await member('carol')
      await assertSucceeds(setDoc(doc(ctx('carol'), 'users/carol/notes/n1'), valid()))
    })
  })

  describe('missing or invalid authorization state denies access', () => {
    const cases: Array<[string, Record<string, unknown> | null]> = [
      ['no membership document', null],
      ['active: false', { active: false }],
      ['active as the string "true"', { active: 'true' }],
      ['active as the number 1', { active: 1 }],
      ['active: null', { active: null }],
      ['no active field', { member: true }],
      ['an empty document', {}],
      ['an active map', { active: { value: true } }],
    ]
    for (const [name, data] of cases) {
      it(name, async () => {
        if (data) await member('dave', data)
        const d = ctx('dave')
        await assertFails(getDoc(doc(d, 'users/dave/notes/n1')))
        await assertFails(getDocs(collection(d, 'users/dave/notes')))
        await assertFails(setDoc(doc(d, 'users/dave/notes/n1'), valid()))
        await assertFails(getDoc(doc(d, 'users/dave/preferences/appearance')))
        await assertFails(setDoc(doc(d, 'users/dave/preferences/appearance'), prefs()))
      })
    }
    it('membership is per uid: someone else\'s active membership does not help', async () => {
      await assertFails(getDoc(doc(ctx('dave'), 'users/dave/notes/n1')))
      await assertFails(getDoc(doc(ctx('dave'), 'users/alice/notes/n1')))
    })
    it('revoking (active: false, or removing the document) denies at once, and restoring re-admits', async () => {
      const d = ctx('alice')
      await assertSucceeds(getDoc(doc(d, 'users/alice/notes/n1')))
      await member('alice', { active: false })
      await assertFails(getDoc(doc(d, 'users/alice/notes/n1')))
      await assertFails(setDoc(doc(d, 'users/alice/notes/n2'), valid()))
      await member('alice')
      await assertSucceeds(getDoc(doc(d, 'users/alice/notes/n1')))
      await env.withSecurityRulesDisabled((c) => deleteDoc(doc(c.firestore(), 'authorizedUsers/alice')))
      await assertFails(getDoc(doc(d, 'users/alice/notes/n1')))
    })
  })

  it('the rules file contains no uid, email or allowlist content', () => {
    const rules = readFileSync('firestore.rules', 'utf8')
    expect(rules).not.toMatch(/auth\.uid\s*==\s*['"]/)
    expect(rules).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
    expect(rules).not.toMatch(/\.token\.email/)    // an email is never the authorization claim
  })
})

describe('the same gate through the real SDK signed in via the Auth emulator (what a modified client can do)', () => {
  afterAll(closeSessions)

  it('an unapproved account can sign in but every note, preference and allowlist request is refused', async () => {
    const approved = await session()
    const id = await createNote(approved.db, approved.uid)
    const mallory = await unapprovedSession()

    const denied = { code: 'permission-denied' }
    await expect(getDocs(collection(mallory.db, 'users', approved.uid, 'notes'))).rejects.toMatchObject(denied)
    await expect(getDoc(doc(mallory.db, 'users', approved.uid, 'notes', id))).rejects.toMatchObject(denied)
    await expect(deleteDoc(doc(mallory.db, 'users', approved.uid, 'notes', id))).rejects.toMatchObject(denied)
    await expect(getDocs(collection(mallory.db, 'users', mallory.uid, 'notes'))).rejects.toMatchObject(denied)
    await expect(createNote(mallory.db, mallory.uid)).rejects.toMatchObject(denied)
    await expect(saveNote(mallory.db, approved.uid, id, { title: 'x', content: '{}' }, 1)).rejects.toMatchObject(denied)
    await expect(deleteNote(mallory.db, approved.uid, id, 1)).rejects.toMatchObject(denied)
    await expect(savePreferences(mallory.db, mallory.uid, { theme: 'dark' })).rejects.toMatchObject(denied)
    await expect(getDoc(doc(mallory.db, 'users', approved.uid, 'preferences', 'appearance'))).rejects.toMatchObject(denied)
    // the allowlist: no read, no self-add, and a failed self-add changes nothing
    await expect(getDoc(doc(mallory.db, 'authorizedUsers', mallory.uid))).rejects.toMatchObject(denied)
    await expect(setDoc(doc(mallory.db, 'authorizedUsers', mallory.uid), { active: true })).rejects.toMatchObject(denied)
    await expect(createNote(mallory.db, mallory.uid)).rejects.toMatchObject(denied)
    // the approved user's note is untouched
    expect((await getDoc(doc(approved.db, 'users', approved.uid, 'notes', id))).data()).toMatchObject({ rev: 1 })
  })

  it('the app\'s listeners report permission-denied for an unapproved account (what the UI keys on)', async () => {
    const mallory = await unapprovedSession()
    const notesErr = await new Promise<{ code?: string }>((res) => subscribeNotes(mallory.db, mallory.uid, () => res({ code: 'data' }), (e) => res(e as { code?: string })))
    const prefsErr = await new Promise<{ code?: string }>((res) => subscribePreferences(mallory.db, mallory.uid, () => res({ code: 'data' }), (e) => res(e as { code?: string })))
    expect(notesErr.code).toBe('permission-denied')
    expect(prefsErr.code).toBe('permission-denied')
  })

  it('an account added to the allowlist later (privileged) gets in without any client change; removing it locks it out again', async () => {
    const u = await unapprovedSession()
    await expect(createNote(u.db, u.uid)).rejects.toMatchObject({ code: 'permission-denied' })
    await provision(u.uid)
    const id = await createNote(u.db, u.uid)
    expect(await saveNote(u.db, u.uid, id, { title: 'in', content: '{}' }, 1)).toBe(2)
    await deprovision(u.uid)
    await expect(getDoc(doc(u.db, 'users', u.uid, 'notes', id))).rejects.toMatchObject({ code: 'permission-denied' })
    await provision(u.uid, { active: { booleanValue: false } })
    await expect(getDoc(doc(u.db, 'users', u.uid, 'notes', id))).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('malformed membership documents written with privileged access still deny', async () => {
    for (const fields of [{}, { active: { stringValue: 'true' } }, { active: { integerValue: '1' } }, { active: { nullValue: null } }]) {
      const u = await unapprovedSession()
      await provision(u.uid, fields)
      await expect(createNote(u.db, u.uid)).rejects.toMatchObject({ code: 'permission-denied' })
    }
  })
})

describe('the same gate with raw REST requests (no SDK)', () => {
  afterAll(closeSessions)
  const base = 'http://localhost:8080/v1/projects/demo-notes/databases/(default)/documents'
  const idToken = (db: Firestore) => getAuth(db.app).currentUser!.getIdToken()
  const call = (path: string, token: string | null, method = 'GET', body?: object) => fetch(`${base}/${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const noteBody = (rev = 1) => ({ fields: {
    title: { stringValue: 't' }, content: { stringValue: '{}' }, rev: { integerValue: String(rev) },
    createdAt: { timestampValue: '2026-01-01T00:00:00Z' }, updatedAt: { timestampValue: '2026-01-01T00:00:00Z' },
  } })

  it('an ID token of an unapproved account gets 403 everywhere, the approved one gets through, anonymous gets 403', async () => {
    const approved = await session(), mallory = await unapprovedSession()
    const at = await idToken(approved.db), mt = await idToken(mallory.db)
    expect((await call(`users/${approved.uid}/notes/r1`, at, 'PATCH', noteBody())).status).toBe(200)
    expect((await call(`users/${approved.uid}/notes`, at)).status).toBe(200)

    for (const [path, method, body] of [
      [`users/${approved.uid}/notes`, 'GET'], [`users/${approved.uid}/notes/r1`, 'GET'],
      [`users/${approved.uid}/notes/r2`, 'PATCH', noteBody()], [`users/${approved.uid}/notes/r1`, 'DELETE'],
      [`users/${mallory.uid}/notes/r1`, 'PATCH', noteBody()], [`users/${mallory.uid}/notes`, 'GET'],
      [`users/${mallory.uid}/preferences/appearance`, 'GET'],
      [`authorizedUsers/${mallory.uid}`, 'GET'], [`authorizedUsers/${mallory.uid}`, 'PATCH', { fields: { active: { booleanValue: true } } }],
      [`authorizedUsers/${approved.uid}`, 'DELETE'], ['authorizedUsers', 'GET'],
    ] as Array<[string, string, object?]>) {
      expect((await call(path, mt, method, body)).status, `${method} ${path}`).toBe(403)
      expect((await call(path, null, method, body)).status, `anonymous ${method} ${path}`).toBe(403)
    }
    // the denied attempts changed nothing: the approved user can still read the allowlist-protected note
    expect((await call(`users/${approved.uid}/notes/r1`, at)).status).toBe(200)
    // and the self-add above did not take effect
    expect((await call(`users/${mallory.uid}/notes`, mt)).status).toBe(403)
  })
})
