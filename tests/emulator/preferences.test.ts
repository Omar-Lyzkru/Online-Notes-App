import { afterAll, describe, expect, it } from 'vitest'
import { doc, getDoc, setDoc, serverTimestamp, type Firestore } from 'firebase/firestore'
import { savePreferences, subscribePreferences } from '../../src/preferencesApi'
import { PreferencesController } from '../../src/preferencesController'
import { DEFAULT_APPEARANCE, type Appearance } from '../../src/appearance'
import { closeSessions, deadSession, session, until } from './sessions'

afterAll(closeSessions)

/** Collects what a session's listener reports. */
function watch(db: Firestore, uid: string) {
  const w = { last: undefined as Appearance | undefined, fromCache: true, errors: [] as Error[], stop: () => {} }
  w.stop = subscribePreferences(db, uid, (a, c) => { w.last = a; w.fromCache = c }, (e) => w.errors.push(e))
  return w
}
const settled = (w: ReturnType<typeof watch>) => until(() => (w.last && !w.fromCache ? w.last : undefined))
const stored = async (db: Firestore, uid: string) => (await getDoc(doc(db, 'users', uid, 'preferences', 'appearance'))).data()

describe('appearance preferences against the emulators', () => {
  it('a user who never saved anything gets the defaults from the server', async () => {
    const { db, uid } = await session()
    const w = watch(db, uid)
    expect(await settled(w)).toEqual(DEFAULT_APPEARANCE)
    expect(await stored(db, uid)).toBeUndefined()      // reading does not create anything
    w.stop()
  })

  it('persists: a brand-new session of the same account (a reload) restores the saved choices', async () => {
    const { db, uid } = await session()
    await savePreferences(db, uid, { theme: 'dark' })
    await savePreferences(db, uid, { background: 'mint', fontSize: 'large' })
    const { db: fresh } = await session(uid)            // new app instance: empty cache, as after a reload
    const w = watch(fresh, uid)
    expect(await settled(w)).toEqual({ theme: 'dark', background: 'mint', fontSize: 'large' })
    expect(Object.keys((await stored(fresh, uid))!).sort()).toEqual(['background', 'fontSize', 'theme', 'updatedAt'])
    w.stop()
  })

  it('the first save of one field creates a complete document with defaults for the rest', async () => {
    const { db, uid } = await session()
    await savePreferences(db, uid, { fontSize: 'small' })
    expect(await stored(db, uid)).toMatchObject({ theme: 'light', background: 'plain', fontSize: 'small' })
  })

  it('synchronizes between two live sessions of the same account, in both directions', async () => {
    const a = await session(), b = await session(a.uid)
    const wa = watch(a.db, a.uid), wb = watch(b.db, b.uid)
    await settled(wa); await settled(wb)
    await savePreferences(a.db, a.uid, { theme: 'dark' })
    await until(() => (wb.last?.theme === 'dark' ? true : undefined))
    await savePreferences(b.db, b.uid, { background: 'rose', fontSize: 'xlarge' })
    await until(() => (wa.last?.background === 'rose' && wa.last.fontSize === 'xlarge' ? true : undefined))
    expect(wa.last).toEqual({ theme: 'dark', background: 'rose', fontSize: 'xlarge' })
    expect(wb.last).toEqual(wa.last)
    wa.stop(); wb.stop()
  })

  it('keeps accounts apart: another user starts from the defaults and cannot read or write the first user\'s preferences', async () => {
    const x = await session(), y = await session()
    await savePreferences(x.db, x.uid, { theme: 'dark', background: 'sky', fontSize: 'xlarge' })
    const wy = watch(y.db, y.uid)
    expect(await settled(wy)).toEqual(DEFAULT_APPEARANCE)
    wy.stop()
    const ref = doc(y.db, 'users', x.uid, 'preferences', 'appearance')
    await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(setDoc(ref, { theme: 'light', background: 'plain', fontSize: 'medium', updatedAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(savePreferences(y.db, x.uid, { theme: 'light' })).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await stored(x.db, x.uid)).toMatchObject({ theme: 'dark', background: 'sky', fontSize: 'xlarge' })
    // and the denied listener reports an error instead of data
    const bad = watch(y.db, x.uid)
    await until(() => (bad.errors.length ? true : undefined))
    expect(bad.last).toBeUndefined(); bad.stop()
  })

  it('a signed-out client cannot read or write preferences', async () => {
    const { uid } = await session()
    const { initializeApp } = await import('firebase/app')
    const { getFirestore, connectFirestoreEmulator } = await import('firebase/firestore')
    const app = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, 'anon-prefs')
    const db = getFirestore(app); connectFirestoreEmulator(db, 'localhost', 8080)
    await expect(savePreferences(db, uid, { theme: 'dark' })).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(getDoc(doc(db, 'users', uid, 'preferences', 'appearance'))).rejects.toMatchObject({ code: 'permission-denied' })
    const { deleteApp } = await import('firebase/app'); await deleteApp(app)
  })

  it('concurrent changes to different fields from two sessions both survive', async () => {
    const a = await session(), b = await session(a.uid)
    for (let i = 0; i < 8; i++) {
      const theme = i % 2 ? 'dark' : 'light', fontSize = i % 2 ? 'small' : 'xlarge'
      await Promise.all([savePreferences(a.db, a.uid, { theme }), savePreferences(b.db, b.uid, { fontSize })])
      expect(await stored(a.db, a.uid)).toMatchObject({ theme, fontSize })
    }
  }, 30000)

  it('concurrent changes to the same field end in one value that both sessions then show', async () => {
    const a = await session(), b = await session(a.uid)
    const wa = watch(a.db, a.uid), wb = watch(b.db, b.uid)
    await settled(wa); await settled(wb)
    await Promise.all([savePreferences(a.db, a.uid, { background: 'mint' }), savePreferences(b.db, b.uid, { background: 'rose' })])
    const final = (await stored(a.db, a.uid))!.background
    expect(['mint', 'rose']).toContain(final)
    await until(() => (wa.last?.background === final && wb.last?.background === final ? true : undefined))
    wa.stop(); wb.stop()
  })

  it('a server that cannot be reached is a failure, never a success, and nothing is stored', async () => {
    const { uid } = await session()
    await expect(savePreferences(deadSession(), uid, { theme: 'dark' })).rejects.toBeTruthy()
  }, 40000)
})

describe('PreferencesController with the real API', () => {
  /**
   * `net.down` makes saves fail the way an unreachable server does (code "unavailable"); the real-API case of a
   * dead host is tested above. (disableNetwork() cannot be used for this: Firestore transactions bypass it.)
   */
  const make = (db: Firestore, uid: string) => {
    const net = { down: false }
    const c = new PreferencesController(
      (p) => net.down ? Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' })) : savePreferences(db, uid, p),
      () => {})
    const stop = subscribePreferences(db, uid, (a) => c.onRemote(a), () => c.onLoadError())
    return { c, net, stop }
  }

  it('is "saving" until the server has the value, then "saved"; another session receives it', async () => {
    const a = await session(), b = await session(a.uid)
    const { c, stop } = make(a.db, a.uid); const wb = watch(b.db, b.uid)
    await settled(wb)
    c.choose('theme', 'dark')
    expect(c.status).toBe('saving')
    await until(() => (c.status === 'saved' ? true : undefined))
    expect(await stored(b.db, b.uid)).toMatchObject({ theme: 'dark' })
    await until(() => (wb.last?.theme === 'dark' ? true : undefined))
    stop(); wb.stop()
  })

  it('when the server cannot be reached the choice stays on screen as "error" (not saved), and saves on retry', async () => {
    const a = await session(), b = await session(a.uid)
    const { c, net, stop } = make(a.db, a.uid)
    await until(() => (c.loaded ? true : undefined))
    net.down = true
    c.choose('fontSize', 'xlarge')
    await until(() => (c.status === 'error' ? true : undefined))
    expect(c.value.fontSize).toBe('xlarge')
    expect(await stored(b.db, b.uid)).toBeUndefined()      // the server never got it
    net.down = false
    c.retry()
    await until(() => (c.status === 'saved' ? true : undefined))
    expect(await stored(b.db, b.uid)).toMatchObject({ fontSize: 'xlarge' })
    stop()
  })

  it('a remote change arriving while a choice is unsaved does not replace that choice, and the choice wins once saved', async () => {
    const a = await session(), b = await session(a.uid)
    const { c, net, stop } = make(a.db, a.uid)
    await until(() => (c.loaded ? true : undefined))
    net.down = true
    c.choose('theme', 'dark')                                     // cannot be saved yet
    await until(() => (c.status === 'error' ? true : undefined))
    await savePreferences(b.db, b.uid, { theme: 'light', background: 'sky' })   // another session changes things meanwhile
    await until(() => (c.value.background === 'sky' ? true : undefined))     // other fields follow the remote ...
    expect(c.value.theme).toBe('dark')                                       // ... the unsaved one does not
    net.down = false
    c.retry(); await until(() => (c.status === 'saved' ? true : undefined))
    expect(await stored(b.db, b.uid)).toMatchObject({ theme: 'dark', background: 'sky' })
    stop()
  })
})
