import type { FirebaseOptions } from 'firebase/app'
import { connectAuthEmulator, type Auth } from 'firebase/auth'
import { connectFirestoreEmulator, type Firestore } from 'firebase/firestore'

// Local development only. `firebase.ts` references this module solely behind `!import.meta.env.PROD`, so a
// production bundle contains none of it (`scripts/verify-dist.mjs` checks that).

/** A demo-* project never exists remotely; the emulators accept any key. */
export const EMULATOR_OPTIONS: FirebaseOptions = {
  apiKey: 'demo-key',
  // The Auth SDK refuses popup sign-in without an authDomain, even against the emulator (which supplies its own URL).
  authDomain: 'localhost',
  projectId: 'demo-notes',
}

export function connectEmulators(auth: Auth, db: Firestore): void {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, 'localhost', 8080)
}
