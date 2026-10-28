import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteApp, getApps } from 'firebase/app'
import { ConfigError, liveOptions, resolveFirebaseSetup } from '../src/firebaseConfig'

// Synthetic values in the shape of a real web config (no real project).
const LIVE = {
  VITE_FIREBASE_API_KEY: 'AIzaSyExampleExampleExampleExample0000',
  VITE_FIREBASE_AUTH_DOMAIN: 'notes-example-1234.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'notes-example-1234',
  VITE_FIREBASE_APP_ID: '1:123456789012:web:abcdef0123456789',
}
const problems = (env: Record<string, unknown>, prod: boolean) => {
  try { resolveFirebaseSetup(env, prod) } catch (e) { return (e as ConfigError).problems }
  return []
}

describe('resolveFirebaseSetup — production builds', () => {
  it('accepts a complete, consistent live configuration', () => {
    expect(resolveFirebaseSetup(LIVE, true)).toEqual({ kind: 'live', options: {
      apiKey: LIVE.VITE_FIREBASE_API_KEY, authDomain: LIVE.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: 'notes-example-1234', appId: LIVE.VITE_FIREBASE_APP_ID,
    } })
  })
  it('accepts the .web.app domain of the same project, and an explicit VITE_USE_EMULATORS=false', () => {
    expect(problems({ ...LIVE, VITE_FIREBASE_AUTH_DOMAIN: 'notes-example-1234.web.app', VITE_USE_EMULATORS: 'false' }, true)).toEqual([])
  })
  it('never falls back: an empty environment is an error naming every missing value', () => {
    const p = problems({}, true).join('\n')
    for (const k of ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'APP_ID']) expect(p).toContain(`VITE_FIREBASE_${k} is missing`)
  })
  it('refuses to be built for the emulators, whatever else is set', () => {
    expect(problems({ ...LIVE, VITE_USE_EMULATORS: 'true' }, true).join()).toMatch(/not allowed in a production build/)
    expect(problems({ VITE_USE_EMULATORS: 'true' }, true).length).toBeGreaterThan(1)
  })
  it('rejects ambiguous emulator flag values', () => {
    for (const v of ['1', 'yes', 'TRUE']) expect(problems({ ...LIVE, VITE_USE_EMULATORS: v }, true).join()).toMatch(/must be "true", "false" or empty/)
  })
  it('rejects the emulator placeholders and demo projects', () => {
    expect(problems({ ...LIVE, VITE_FIREBASE_API_KEY: 'demo-key' }, true).join()).toMatch(/emulator placeholder/)
    expect(problems({ ...LIVE, VITE_FIREBASE_PROJECT_ID: 'demo-notes', VITE_FIREBASE_AUTH_DOMAIN: 'demo-notes.firebaseapp.com' }, true).join()).toMatch(/demo project/)
    expect(problems({ ...LIVE, VITE_FIREBASE_AUTH_DOMAIN: 'localhost' }, true).join()).toMatch(/does not belong to project/)
  })
  it('rejects an auth domain of another project (a mismatched project is the dangerous mistake)', () => {
    expect(problems({ ...LIVE, VITE_FIREBASE_AUTH_DOMAIN: 'other-project-99.firebaseapp.com' }, true).join()).toMatch(/does not belong to project "notes-example-1234"/)
  })
  it('rejects malformed project ids and app ids, and whitespace-only values', () => {
    expect(problems({ ...LIVE, VITE_FIREBASE_PROJECT_ID: 'Bad_ID' }, true).join()).toMatch(/not a valid Firebase project ID/)
    expect(problems({ ...LIVE, VITE_FIREBASE_APP_ID: 'abc' }, true).join()).toMatch(/not a web app id/)
    expect(problems({ ...LIVE, VITE_FIREBASE_API_KEY: '   ' }, true).join()).toMatch(/API_KEY is missing/)
  })
  it('liveOptions refuses an emulator setup instead of inventing options', () => {
    expect(() => liveOptions({ kind: 'emulator' })).toThrow(ConfigError)
  })
})

describe('resolveFirebaseSetup — dev server', () => {
  it('uses the emulators by default, with no environment at all', () => {
    expect(resolveFirebaseSetup({}, false)).toEqual({ kind: 'emulator' })
    expect(resolveFirebaseSetup({ VITE_USE_EMULATORS: 'true', VITE_FIREBASE_AUTH_DOMAIN: '' }, false)).toEqual({ kind: 'emulator' })
  })
  it('talks to a live project only when explicitly told to, and then needs the full configuration', () => {
    expect(resolveFirebaseSetup({ ...LIVE, VITE_USE_EMULATORS: 'false' }, false).kind).toBe('live')
    expect(problems({ VITE_USE_EMULATORS: 'false' }, false).length).toBe(4)
  })
})

// The module that actually initializes Firebase, in the dev/test environment (PROD is false there).
async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('../src/firebase')
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(getApps().map(deleteApp)) // firebase/app keeps its registry across vi.resetModules()
})

describe('src/firebase.ts', () => {
  it('connects to the emulators in development with the documented empty values', async () => {
    const { auth } = await load({ VITE_USE_EMULATORS: '', VITE_FIREBASE_AUTH_DOMAIN: '' })
    expect(auth.config.authDomain).toBeTruthy()
    expect(auth.emulatorConfig?.host).toBe('localhost')
    expect(getApps()[0].options.projectId).toBe('demo-notes')
  })
  it('a live development configuration uses the given project and never the emulators', async () => {
    const { auth } = await load({ ...LIVE, VITE_USE_EMULATORS: 'false' })
    expect(auth.emulatorConfig).toBeNull()
    expect(auth.config.authDomain).toBe(LIVE.VITE_FIREBASE_AUTH_DOMAIN)
    expect(getApps()[0].options.projectId).toBe('notes-example-1234')
  })
  it('a production environment with the emulator flag set fails at import instead of using the emulators', async () => {
    vi.stubEnv('PROD', true); vi.stubEnv('DEV', false)
    // (a fresh module graph per load, so match on the shape rather than the class)
    await expect(load({ ...LIVE, VITE_USE_EMULATORS: 'true' })).rejects.toMatchObject({ problems: [expect.stringMatching(/not allowed in a production build/)] })
    vi.unstubAllEnvs(); vi.stubEnv('PROD', true); vi.stubEnv('DEV', false)   // stubs persist across loads: start the next one from nothing
    await expect(load({ VITE_USE_EMULATORS: '' })).rejects.toMatchObject({ problems: expect.arrayContaining(['VITE_FIREBASE_PROJECT_ID is missing.']) })
  })
  it('a complete production environment never connects to the emulators', async () => {
    vi.stubEnv('PROD', true); vi.stubEnv('DEV', false)
    const { auth } = await load({ ...LIVE, VITE_USE_EMULATORS: '' })
    expect(auth.emulatorConfig).toBeNull()
    expect(getApps()[0].options.projectId).toBe('notes-example-1234')
  })
})
