import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { liveOptions, resolveFirebaseSetup } from './firebaseConfig'
import { EMULATOR_OPTIONS, connectEmulators } from './emulators'

const PROD = import.meta.env.PROD
// Throws a ConfigError for a missing or inconsistent configuration; main.tsx checks the same thing first and shows it.
const setup = resolveFirebaseSetup(import.meta.env, PROD)
// A production build can never use the emulators: `!PROD` is a build-time constant, so this branch and
// everything it references are removed from the bundle.
const emulate = !PROD && setup.kind === 'emulator'

const app = initializeApp(emulate ? EMULATOR_OPTIONS : liveOptions(setup))

export const auth = getAuth(app)
// getFirestore uses the default in-memory cache: no persistent offline cache is enabled (needs owner approval).
export const db = getFirestore(app)

if (emulate) connectEmulators(auth, db)
