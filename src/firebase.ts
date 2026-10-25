import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'

const env = import.meta.env
const useEmulators = env.VITE_USE_EMULATORS === 'true'

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  // The Auth SDK refuses popup sign-in without an authDomain, even against the emulator (which supplies its own URL).
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || (useEmulators ? 'localhost' : undefined),
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-notes',
  appId: env.VITE_FIREBASE_APP_ID,
})

export const auth = getAuth(app)
// getFirestore uses the default in-memory cache: no persistent offline cache is enabled (needs owner approval).
export const db = getFirestore(app)

if (useEmulators) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, 'localhost', 8080)
}
