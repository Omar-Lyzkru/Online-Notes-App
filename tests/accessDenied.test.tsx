import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signInWithPopup, signOut } from 'firebase/auth'
import App from '../src/App'
import { subscribePreferences } from '../src/preferencesApi'
import { DEFAULT_APPEARANCE, type Appearance } from '../src/appearance'
import { EMPTY_DOC, subscribeNotes, type Note } from '../src/notesApi'

/**
 * What an account that authenticated but is not on the allowlist sees. The refusal itself comes from the
 * Firestore rules (tests/emulator/allowlist.test.ts); these jsdom tests cover only the explanation shown to
 * the user, with Firebase replaced by fakes.
 */
const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  authCb: (_: unknown) => {},
  notes: { data: (_n: unknown[], _cache: boolean) => {}, fail: (_e: unknown) => {} },
  providers: [] as Array<{ params?: Record<string, string> }>,
}))

vi.mock('../src/firebase', () => ({ auth: { currentUser: null }, db: {} }))
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class { params?: Record<string, string>; constructor() { h.providers.push(this) } setCustomParameters(p: Record<string, string>) { this.params = p } },
  onAuthStateChanged: (_a: unknown, cb: (u: unknown) => void) => { h.authCb = cb; cb(h.user); return () => {} },
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('../src/notesApi', async (orig) => ({
  ...(await orig<typeof import('../src/notesApi')>()),
  subscribeNotes: vi.fn(), createNote: vi.fn(), saveNote: vi.fn(), deleteNote: vi.fn(),
}))
vi.mock('../src/preferencesApi', () => ({ subscribePreferences: vi.fn(), savePreferences: vi.fn() }))
vi.mock('@tiptap/react', () => ({
  useEditor: () => ({ destroyed: false, getJSON: () => ({ type: 'doc', content: [] }), isActive: () => false, chain: () => ({}), commands: { setContent: () => {} } }),
  EditorContent: () => null,
}))

const note = (id: string, title: string): Note => ({ id, title, content: EMPTY_DOC, rev: 1, updatedAt: 1 })
const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })

let root: Root, host: HTMLElement
const flush = () => act(async () => { await Promise.resolve() })
const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''))!
const click = (re: RegExp) => act(async () => { button(re).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const text = () => host.textContent ?? ''

async function mount(opts: { refuse?: boolean } = {}) {
  vi.mocked(subscribeNotes).mockReset().mockImplementation(((_db: unknown, _uid: string, onData: (n: Note[], c: boolean, p: boolean) => void, onError: (e: Error) => void) => {
    h.notes.data = (n, cache) => onData(n as Note[], cache, false)
    h.notes.fail = (e) => onError(e as Error)
    if (opts.refuse) onError(denied())
    return () => {}
  }) as any)
  vi.mocked(subscribePreferences).mockReset().mockImplementation(((_db: unknown, _uid: string, onData: (a: Appearance, c: boolean) => void, onError: (e: Error) => void) => {
    if (opts.refuse) onError(denied()); else onData(DEFAULT_APPEARANCE, false)
    return () => {}
  }) as any)
  root = createRoot(host)
  await act(async () => { root.render(<App />) })
  await flush()
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  h.providers.length = 0
  h.user = { uid: 'mallory', displayName: 'Mallory Example', email: 'mallory@example.com' }
  vi.mocked(signOut).mockReset().mockResolvedValue(undefined)
  vi.mocked(signInWithPopup).mockReset().mockResolvedValue(undefined as never)
  host = document.createElement('div'); document.body.append(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

describe('an authenticated account the server refuses', () => {
  it('sees a clear access-denied explanation, not an empty notebook, a spinner or a generic error', async () => {
    await mount({ refuse: true })
    expect(text()).toContain('Access denied')
    expect(text()).toContain('Mallory Example')
    expect(text()).toContain('not authorized')
    expect(text()).not.toMatch(/No notes yet|Loading|New note|Select or create|Missing or insufficient/)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.querySelector('.sidebar, .search, input')).toBeNull()      // no notebook chrome
  })

  it('can sign out from there, directly (there is no draft to protect)', async () => {
    await mount({ refuse: true })
    await click(/^Sign out$/)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('reports a failed sign-out instead of hiding it', async () => {
    vi.mocked(signOut).mockRejectedValue(new Error('network down'))
    await mount({ refuse: true })
    await click(/^Sign out$/); await flush()
    expect(text()).toContain('Sign-out failed: network down')
    expect(text()).toContain('Access denied')
  })

  it('does not disclose allowlist details or the account id', async () => {
    await mount({ refuse: true })
    expect(text()).not.toMatch(/mallory@|authorizedUsers|allowlist|uid|permission-denied/i)
  })

  it('signing in again offers the Google account chooser, so another account can be picked', async () => {
    h.user = null
    await mount()
    await click(/Sign in with Google/)
    expect(signInWithPopup).toHaveBeenCalledTimes(1)
    expect(h.providers.at(-1)?.params).toEqual({ prompt: 'select_account' })
  })

  it('a different account on the same page starts clean (state is keyed by uid)', async () => {
    await mount({ refuse: true })
    expect(text()).toContain('Access denied')
    vi.mocked(subscribeNotes).mockReset().mockImplementation(((_db: unknown, _uid: string, onData: (n: Note[], c: boolean, p: boolean) => void) => { onData([note('A', 'Approved note')], false, false); return () => {} }) as any)
    vi.mocked(subscribePreferences).mockReset().mockImplementation(((_db: unknown, _uid: string, onData: (a: Appearance, c: boolean) => void) => { onData(DEFAULT_APPEARANCE, false); return () => {} }) as any)
    h.user = { uid: 'owner', displayName: 'Owner' }
    await act(async () => { h.authCb(h.user) })
    expect(text()).not.toContain('Access denied')
    expect(text()).toContain('Approved note')
  })
})

describe('an approved account', () => {
  it('is not shown the denial', async () => {
    await mount()
    act(() => { h.notes.data([note('A', 'First note')], false) })
    expect(text()).not.toContain('Access denied')
    expect(text()).toContain('First note')
  })

  it('a refusal after it was let in (access removed mid-session) keeps the notebook and shows the error, never discarding the screen', async () => {
    await mount()
    act(() => { h.notes.data([note('A', 'First note')], false) })
    act(() => { h.notes.fail(denied()) })
    expect(text()).not.toContain('Access denied')
    expect(text()).toContain('First note')
    expect(text()).toContain('Missing or insufficient permissions.')
  })

  it('other listener errors (not a permission refusal) are not read as "not authorized"', async () => {
    await mount()
    act(() => { h.notes.fail(Object.assign(new Error('unavailable'), { code: 'unavailable' })) })
    expect(text()).not.toContain('Access denied')
    expect(text()).toContain('unavailable')
  })

  it('a cache-only snapshot does not count as having been let in', async () => {
    await mount()
    act(() => { h.notes.data([], true) })
    act(() => { h.notes.fail(denied()) })
    expect(text()).toContain('Access denied')
  })
})
