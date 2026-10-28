import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolveFirebaseSetup } from './src/firebaseConfig.ts'

export default defineConfig(({ command, mode }) => {
  // A production build must carry a complete, consistent live Firebase configuration and no emulator flag:
  // fail here, loudly, rather than ship a bundle that cannot work or talks to the wrong place.
  if (command === 'build') {
    // `import.meta.env.PROD` (what removes the emulator code from the bundle) follows NODE_ENV, not the build command:
    // with NODE_ENV=development a build would keep the emulator branch and default to the emulators at runtime.
    const nodeEnv = process.env.NODE_ENV
    if (nodeEnv && nodeEnv !== 'production') {
      throw new Error(`A production build must run with NODE_ENV=production (found "${nodeEnv}"): otherwise emulator code would stay in the bundle. Unset NODE_ENV.`)
    }
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    const setup = resolveFirebaseSetup(env, true)
    if (setup.kind !== 'live') throw new Error('A production build needs a live Firebase configuration.')
  }
  return { plugins: [react()], test: { environment: 'jsdom' } }
})
