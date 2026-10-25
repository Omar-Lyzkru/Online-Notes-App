import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteApp, getApps } from 'firebase/app'

// Popup sign-in needs an authDomain even against the emulator; the documented setup (`cp .env.example .env.local`) leaves it empty.
async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return (await import('../src/firebase')).auth
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(getApps().map(deleteApp)) // firebase/app keeps its registry across vi.resetModules()
})

describe('firebase config', () => {
  it('emulator mode works with the documented empty .env.example values', async () => {
    const auth = await load({ VITE_USE_EMULATORS: 'true', VITE_FIREBASE_AUTH_DOMAIN: '', VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '' })
    expect(auth.config.authDomain).toBeTruthy()
    expect(auth.emulatorConfig?.host).toBe('localhost')
  })
  it('an explicit auth domain always wins', async () => {
    const auth = await load({ VITE_USE_EMULATORS: 'true', VITE_FIREBASE_AUTH_DOMAIN: 'my-app.firebaseapp.com' })
    expect(auth.config.authDomain).toBe('my-app.firebaseapp.com')
  })
  it('a live configuration is never given an invented domain', async () => {
    const auth = await load({ VITE_USE_EMULATORS: 'false', VITE_FIREBASE_AUTH_DOMAIN: '' })
    expect(auth.config.authDomain).toBeFalsy()
    expect(auth.emulatorConfig).toBeNull()
  })
})
