import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore'
import { connectAuthEmulator, getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth'

const apps: FirebaseApp[] = []
let n = 0

/**
 * A separate app instance (own Firestore cache and connection) against the emulators, signed in either
 * as a fresh anonymous user or, with `sameUidAs`, as an existing uid (the Auth emulator accepts unsigned custom tokens).
 */
export async function session(sameUidAs?: string): Promise<{ db: Firestore; uid: string }> {
  const app = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, `s${++n}`); apps.push(app)
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  const db = getFirestore(app); connectFirestoreEmulator(db, 'localhost', 8080)
  if (sameUidAs) {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    await signInWithCustomToken(auth, enc({ alg: 'none', typ: 'JWT' }) + '.' + enc({
      uid: sameUidAs, aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iss: 'x', sub: 'x', iat: 0, exp: 9999999999,
    }) + '.')
  } else await signInAnonymously(auth)
  return { db, uid: auth.currentUser!.uid }
}

/** A client that cannot reach any server. */
export function deadSession(): Firestore {
  const app = initializeApp({ apiKey: 'k', projectId: 'demo-notes' }, `dead${++n}`); apps.push(app)
  const db = getFirestore(app); connectFirestoreEmulator(db, 'localhost', 1)
  return db
}

export const closeSessions = () => Promise.all(apps.splice(0).map(deleteApp))

export const until = <T,>(get: () => T | undefined, ms = 8000) => new Promise<T>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    const v = get()
    if (v !== undefined) { clearInterval(i); res(v) } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 25)
})
