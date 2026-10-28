import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The production build path: configuration is enforced at build time, the emulator code cannot reach a
 * production bundle, and scripts/verify-dist.mjs catches a bundle that is wrong. Synthetic project values only.
 */
const LIVE = {
  VITE_FIREBASE_API_KEY: 'AIzaSyExampleExampleExampleExample0000',
  VITE_FIREBASE_AUTH_DOMAIN: 'notes-example-1234.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'notes-example-1234',
  VITE_FIREBASE_APP_ID: '1:123456789012:web:abcdef0123456789',
}
const PROJECT = 'notes-example-1234'

// A clean environment: nothing from the developer's shell or .env files can leak into these builds.
const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {}
  // (vitest itself runs with NODE_ENV=test, which a production build must not inherit)
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITE_') && k !== 'NODE_ENV' && v !== undefined) env[k] = v
  return { ...env, ...extra }
}
let work: string
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'notes-prod-')) })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const build = (outDir: string, extra: Record<string, string>) =>
  spawnSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { env: cleanEnv(extra), encoding: 'utf8', cwd: process.cwd() })
const verify = (dir: string, ...args: string[]) =>
  spawnSync('node', ['scripts/verify-dist.mjs', '--dir', dir, ...args], { env: cleanEnv(), encoding: 'utf8', cwd: process.cwd() })

describe('vite build', () => {
  it('fails, naming every problem, when the production configuration is missing', () => {
    const r = build(join(work, 'missing'), {})
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/VITE_FIREBASE_PROJECT_ID is missing/)
    expect(readdirSyncSafe(join(work, 'missing'))).toEqual([])
  }, 60_000)

  it('fails when it would be built for the emulators, even with a complete live configuration', () => {
    const r = build(join(work, 'emu'), { ...LIVE, VITE_USE_EMULATORS: 'true' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not allowed in a production build/)
  }, 60_000)

  it('fails when NODE_ENV is not production, which would keep the emulator code in the bundle', () => {
    for (const nodeEnv of ['development', 'test']) {
      const r = build(join(work, `nodeenv-${nodeEnv}`), { ...LIVE, NODE_ENV: nodeEnv })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/must run with NODE_ENV=production/)
    }
  }, 60_000)

  it('fails on an inconsistent configuration (auth domain of another project)', () => {
    const r = build(join(work, 'mismatch'), { ...LIVE, VITE_FIREBASE_AUTH_DOMAIN: 'another-project-9.firebaseapp.com' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/does not belong to project/)
  }, 60_000)

  describe('a valid production build', () => {
    const out = () => join(work, 'ok')
    beforeAll(() => { const r = build(out(), LIVE); if (r.status !== 0) throw new Error(r.stdout + r.stderr) }, 120_000)
    const bundle = () => readdirSync(join(out(), 'assets')).filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(out(), 'assets', f), 'utf8')).join('\n')

    it('carries the configured project and none of the emulator wiring', () => {
      const js = bundle()
      expect(js).toContain(PROJECT)
      expect(js).not.toMatch(/localhost:(9099|8080)/)
      expect(js).not.toMatch(/["'`]localhost["'`]\s*,\s*8080/)
      expect(js).not.toMatch(/projectId:\s*["'`]demo-notes/)
      expect(js).not.toMatch(/apiKey:\s*["'`]demo-key/)
    })
    it('passes verify-dist for that project, and fails it for any other', () => {
      expect(verify(out(), '--project', PROJECT)).toMatchObject({ status: 0 })
      const other = verify(out(), '--project', 'some-other-project')
      expect(other.status).toBe(1)
      expect(other.stderr).toMatch(/does not contain project id/)
    })
    it('ships no env file, source map or rules file', () => {
      expect(readdirSyncSafe(out(), true).filter((f) => /\.env|\.map$|\.rules$|firebase\.json/.test(f))).toEqual([])
    })
  })
})

describe('scripts/verify-dist.mjs', () => {
  const fake = (name: string, files: Record<string, string>) => {
    const dir = join(work, name); mkdirSync(join(dir, 'assets'), { recursive: true })
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c)
    return dir
  }
  const good = `const o={apiKey:\`AIzaX\`,authDomain:\`${PROJECT}.firebaseapp.com\`,projectId:\`${PROJECT}\`}`

  it('requires the project to be named explicitly, and refuses demo projects', () => {
    const dir = fake('v-clean', { 'assets/a.js': good })
    expect(verify(dir).status).toBe(2)
    expect(verify(dir, '--project', 'demo-notes').status).toBe(2)
    expect(verify(join(work, 'does-not-exist'), '--project', PROJECT).status).toBe(2)
    expect(verify(dir, '--project', PROJECT).status).toBe(0)
  })
  const bad: Array<[string, string, RegExp]> = [
    ['an emulator endpoint', 'fetch("http://localhost:9099")', /emulator endpoint/],
    ['the Firestore emulator host', 'x("localhost",8080)', /Firestore emulator host/],
    ['the emulator options', 'initializeApp({apiKey:`demo-key`,projectId:`demo-notes`})', /emulator placeholder API key/],
    ['a demo project id', 'const o={projectId:`demo-notes`}', /demo project id/],
    ['a private key', '"-----BEGIN PRIVATE KEY-----\\nabc"', /private key/],
    ['a service-account json', '{"type":"service_account","private_key":"x"}', /service-account/],
    ['an OAuth client secret', 'const s="GOCSPX-abcdefghijklmnop"', /OAuth client secret/],
    ['another project\'s domain', 'const u="https://rival-project-77.web.app"', /other Firebase project domains: rival-project-77/],
  ]
  for (const [name, content, re] of bad) {
    it(`rejects a bundle containing ${name}`, () => {
      const dir = fake(`v-${name.replace(/\W+/g, '-')}`, { 'assets/a.js': `${good};${content}` })
      const r = verify(dir, '--project', PROJECT)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(re)
    })
  }
  it('rejects stray files (env file, source map, service-account json)', () => {
    const dir = fake('v-files', { 'assets/a.js': good, '.env.local': 'X=1', 'assets/a.js.map': '{}', 'my-adminsdk-abc.json': '{}' })
    const r = verify(dir, '--project', PROJECT)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/\.env\.local/); expect(r.stderr).toMatch(/a\.js\.map/); expect(r.stderr).toMatch(/adminsdk/)
  })
  it('does not mistake a public web API key for a credential', () => {
    const dir = fake('v-apikey', { 'assets/a.js': `${good};const k="AIzaSyExampleExampleExampleExample0000"` })
    expect(verify(dir, '--project', PROJECT).status).toBe(0)
  })
})

function readdirSyncSafe(dir: string, deep = false): string[] {
  try {
    return readdirSync(dir, { recursive: deep }).map(String)
  } catch { return [] }
}
