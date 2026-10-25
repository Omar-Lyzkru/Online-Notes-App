import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signOut } from 'firebase/auth'
import App from '../src/App'
import { subscribePreferences, savePreferences } from '../src/preferencesApi'
import { DEFAULT_APPEARANCE, type Appearance } from '../src/appearance'
import { ConflictError, DeleteOutcomeUnknownError, EMPTY_DOC, createNote, deleteNote, saveNote, subscribeNotes, type Note } from '../src/notesApi'

/**
 * UI-level regression tests: the real App and Editor run in jsdom (not a real browser). Firebase and
 * the Tiptap view layer are replaced with controllable fakes; no network or emulator is involved.
 */
const h = vi.hoisted(() => ({
  push: (_: unknown[], _cache?: boolean, _pending?: boolean) => {},
  pushPrefs: (_: Appearance, _cache?: boolean) => {},
  editorOpts: null as any,
  doc: { type: 'doc', content: [] as unknown[] },
}))

vi.mock('../src/firebase', () => ({ auth: { currentUser: { uid: 'u1' } }, db: {} }))
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {},
  onAuthStateChanged: (_a: unknown, cb: (u: unknown) => void) => { cb({ uid: 'u1', displayName: 'Tester' }); return () => {} },
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('../src/notesApi', async (orig) => ({
  ...(await orig<typeof import('../src/notesApi')>()),
  subscribeNotes: vi.fn(), createNote: vi.fn(), saveNote: vi.fn(), deleteNote: vi.fn(),
}))
vi.mock('../src/preferencesApi', () => ({ subscribePreferences: vi.fn(), savePreferences: vi.fn() }))
vi.mock('@tiptap/react', async () => {
  const React = await import('react')
  // Like the real editor, an instance is destroyed when its component unmounts, and commands on it then throw.
  return {
    useEditor: (opts: unknown) => {
      h.editorOpts = opts
      const editor = React.useMemo(() => {
        const ed: any = {
          destroyed: false, getJSON: () => h.doc, isActive: () => false, chain: () => ({}),
          commands: { setContent: () => { if (ed.destroyed) throw new Error('The editor view is not available (destroyed).') } },
        }
        return ed
      }, [])
      React.useEffect(() => { editor.destroyed = false; return () => { editor.destroyed = true } }, [editor])
      return editor
    },
    EditorContent: () => null,
  }
})

const note = (id: string, title: string, rev = 1): Note => ({ id, title, content: EMPTY_DOC, rev, updatedAt: rev })
const A = note('A', 'Note A'), B = note('B', 'Note B')

let root: Root, host: HTMLElement
const confirmFn = vi.fn<(m?: string) => boolean>()

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''))!
const click = (re: RegExp) => act(async () => { button(re).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const titleInput = () => host.querySelector<HTMLInputElement>('input.title')!
const typeTitle = (v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(titleInput(), v)
  titleInput().dispatchEvent(new Event('input', { bubbles: true }))
})
const pushNotes = (n: Note[], cache = false, pending = false) => act(async () => { h.push(n, cache, pending) })
const openNote = async (n: Note) => { await click(new RegExp(`^${n.title}$`)); await flush() }
const status = () => host.querySelector('.status')?.textContent ?? ''
const deferred = () => {
  let resolve!: (rev: number) => void, reject!: (e: unknown) => void
  const promise = new Promise<number>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.useFakeTimers()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('confirm', confirmFn)
  confirmFn.mockReset().mockReturnValue(false) // an unexpected prompt cancels, which the tests then catch
  vi.mocked(signOut).mockReset().mockResolvedValue(undefined)
  vi.mocked(saveNote).mockReset().mockResolvedValue(2)
  vi.mocked(deleteNote).mockReset().mockResolvedValue('deleted')
  vi.mocked(subscribeNotes).mockReset().mockImplementation(((_db: unknown, _uid: string, onData: (n: Note[], c: boolean, p: boolean) => void) => {
    h.push = (n, cache = false, pending = false) => onData(n as Note[], cache, pending)
    onData([A, B], false, false)
    return () => {}
  }) as any)
  vi.mocked(subscribePreferences).mockReset().mockImplementation(((_db: unknown, _uid: string, onData: (a: Appearance, c: boolean) => void) => {
    h.pushPrefs = (a, cache = false) => onData(a, cache)
    onData(DEFAULT_APPEARANCE, false)
    return () => {}
  }) as any)
  vi.mocked(savePreferences).mockReset().mockResolvedValue(undefined)
  h.doc = { type: 'doc', content: [] }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<App />) })
  await flush()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('F1 — sign-out never silently discards edits', () => {
  it('saves a dirty draft first, then signs out, without prompting', async () => {
    await openNote(A)
    await typeTitle('Hello')
    expect(status()).toContain('Unsaved')
    await click(/^Sign out$/); await flush()
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'Hello' }), 1)
    expect(confirmFn).not.toHaveBeenCalled()
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveNote).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(signOut).mock.invocationCallOrder[0])
  })

  it('saves editor content edits too', async () => {
    await openNote(A)
    h.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] }
    await act(async () => { h.editorOpts.onUpdate({ editor: { getJSON: () => h.doc } }) })
    await click(/^Sign out$/); await flush()
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ content: JSON.stringify(h.doc) }), 1)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('waits for a write in flight and signs out only after the server ack', async () => {
    const w = deferred()
    vi.mocked(saveNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('Hello'); await flush(800)
    expect(status()).toContain('Saving')
    await click(/^Sign out$/); await flush(1000)
    expect(signOut).not.toHaveBeenCalled(); expect(confirmFn).not.toHaveBeenCalled()
    w.resolve(2); await flush()
    expect(signOut).toHaveBeenCalledTimes(1); expect(confirmFn).not.toHaveBeenCalled()
  })

  it('failed save: warns, and Cancel keeps the user signed in with the draft intact', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    await openNote(A); await typeTitle('Draft'); await click(/^Sign out$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0][0]).toMatch(/Cancel to stay signed in and keep your draft/)
    expect(signOut).not.toHaveBeenCalled()
    expect(titleInput().value).toBe('Draft'); expect(status()).toContain('Save failed')
    expect(button(/^Sign out$/).hasAttribute('disabled')).toBe(false) // usable again
  })

  it('discarding is explicit: only OK signs out', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    confirmFn.mockReturnValue(true)
    await openNote(A); await typeTitle('Draft'); await click(/^Sign out$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('a save that never answers falls back to the prompt after 3 s instead of hanging', async () => {
    vi.mocked(saveNote).mockReturnValue(new Promise(() => {}))
    await openNote(A); await typeTitle('Draft'); await flush(800)
    await click(/^Sign out$/); await flush(2999)
    expect(confirmFn).not.toHaveBeenCalled()
    await flush(1)
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(signOut).not.toHaveBeenCalled()
  })

  it('conflict: warns and does not sign out on Cancel', async () => {
    vi.mocked(saveNote).mockRejectedValue(new ConflictError(note('A', 'Theirs', 5)))
    await openNote(A); await typeTitle('Mine'); await flush(800)
    expect(status()).toContain('Conflict')
    await click(/^Sign out$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(signOut).not.toHaveBeenCalled()
    expect(titleInput().value).toBe('Mine')
  })

  it('a clean note signs out immediately without a prompt', async () => {
    await openNote(A)
    await click(/^Sign out$/); await flush()
    expect(confirmFn).not.toHaveBeenCalled(); expect(signOut).toHaveBeenCalledTimes(1)
    expect(saveNote).not.toHaveBeenCalled()
  })
})

describe('F3 — deleting a note leaves no stale state', () => {
  it('after deleting a note with a failed draft, switching and signing out do not warn', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    await openNote(A); await typeTitle('Draft'); await flush(800)
    expect(status()).toContain('Save failed')
    const writes = vi.mocked(saveNote).mock.calls.length

    confirmFn.mockReturnValue(true)
    await click(/^Delete note$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1) // only "Delete this note permanently?"
    expect(deleteNote).toHaveBeenCalledWith({}, 'u1', 'A', 1)
    await pushNotes([B]); await openNote(B)
    await click(/^Sign out$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledTimes(1)
    await flush(10000)
    expect(vi.mocked(saveNote).mock.calls.length).toBe(writes) // the deleted note's draft is never written again
  })

  it('a dirty draft of the deleted note is never saved after the delete', async () => {
    await openNote(A); await typeTitle('Draft')
    confirmFn.mockReturnValue(true)
    await click(/^Delete note$/); await flush(5000)
    expect(saveNote).not.toHaveBeenCalled()
    expect(deleteNote).toHaveBeenCalledTimes(1)
  })

  it('the delete waits for a write in flight so it cannot be undone by it', async () => {
    const w = deferred()
    vi.mocked(saveNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('Draft'); await flush(800)
    confirmFn.mockReturnValue(true)
    await click(/^Delete note$/); await flush()
    expect(deleteNote).not.toHaveBeenCalled()
    w.resolve(2); await flush()
    expect(deleteNote).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveNote).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deleteNote).mock.invocationCallOrder[0])
  })

  it("another note's genuine unsaved edits stay protected after a delete elsewhere", async () => {
    await openNote(A)
    confirmFn.mockReturnValue(true)
    await click(/^Delete note$/); await flush()
    await pushNotes([B]); await openNote(B)
    confirmFn.mockReturnValue(false)
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    await typeTitle('Keep me'); await click(/^Sign out$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(2) // the delete prompt + the legitimate sign-out warning
    expect(signOut).not.toHaveBeenCalled()
    expect(titleInput().value).toBe('Keep me')
  })
})

describe('F4 — discarding the draft of a remotely deleted note', () => {
  it('asks no second confirmation and closes the note', async () => {
    await openNote(A); await typeTitle('Draft')
    await pushNotes([B]) // deleted on another device
    expect(host.textContent).toContain('deleted on another device')
    await click(/^Discard my draft$/); await flush()
    expect(confirmFn).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Select or create a note.')
    expect(saveNote).not.toHaveBeenCalled()
  })

  it('keeps the draft until the user chooses (restore recreates the note)', async () => {
    await openNote(A); await typeTitle('Draft')
    await pushNotes([B])
    expect(titleInput().value).toBe('Draft')
    await click(/^Restore my draft$/); await flush()
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'Draft' }), null)
  })
})

describe('F5 — switching notes during a network failure', () => {
  const slowFail = () => vi.mocked(saveNote).mockImplementation(() =>
    new Promise((_, rej) => setTimeout(() => rej(new Error('offline')), 1000)))

  it('does not drop a draft that is still saving: Cancel keeps the note and draft open', async () => {
    slowFail()
    await openNote(A); await typeTitle('Draft'); await flush(800)
    expect(status()).toContain('Saving')
    await click(/^Note B$/); await flush(4000)
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(titleInput().value).toBe('Draft')
    expect(host.querySelector('.sel')?.textContent).toBe('Note A')
  })

  it('a dirty draft (before the autosave fires) is protected the same way', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    await openNote(A); await typeTitle('Draft')
    await click(/^Note B$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(titleInput().value).toBe('Draft')
  })

  it('switching is allowed only after an explicit OK, and the old note then keeps no hold on the new one', async () => {
    const w = deferred()
    vi.mocked(saveNote).mockReturnValue(w.promise)
    confirmFn.mockReturnValue(true)
    await openNote(A); await typeTitle('Draft'); await flush(800)
    await click(/^Note B$/); await flush(3000)
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.sel')?.textContent).toBe('Note B')
    w.reject(new Error('offline')); await flush() // the old note's late failure must not taint Note B
    await click(/^Sign out$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('a healthy network switches without any prompt and without losing the edit', async () => {
    await openNote(A); await typeTitle('Draft')
    await click(/^Note B$/); await flush()
    expect(confirmFn).not.toHaveBeenCalled()
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'Draft' }), 1)
    expect(host.querySelector('.sel')?.textContent).toBe('Note B')
  })
})

describe('stale-after-ack — a newer revision that lands while our write is in flight', () => {
  it('is shown once the write is acknowledged, without a false conflict', async () => {
    const w = deferred()
    vi.mocked(saveNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('Mine'); await flush(800)
    expect(status()).toContain('Saving')
    await pushNotes([note('A', 'Theirs', 3), B]) // another device built on our rev 2 and wrote rev 3
    expect(titleInput().value).toBe('Mine')      // not applied over an in-flight write
    w.resolve(2); await flush()
    expect(titleInput().value).toBe('Theirs')
    expect(status()).toBe('Saved'); expect(confirmFn).not.toHaveBeenCalled()
  })

  it('our own echo changes nothing', async () => {
    const w = deferred()
    vi.mocked(saveNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('Mine'); await flush(800)
    await pushNotes([note('A', 'Mine', 2), B]); w.resolve(2); await flush()
    expect(titleInput().value).toBe('Mine'); expect(status()).toBe('Saved')
  })

  it('does not overwrite text typed while the write was in flight (conflict instead)', async () => {
    const w = deferred()
    vi.mocked(saveNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('Mine'); await flush(800)
    await pushNotes([note('A', 'Theirs', 3), B])
    await typeTitle('Mine, more'); w.resolve(2); await flush()
    expect(titleInput().value).toBe('Mine, more'); expect(status()).toContain('Conflict')
  })
})

describe('revision-aware deletion — what the user sees', () => {
  type Del = 'deleted' | 'already-deleted'
  const pendingDelete = () => {
    let resolve!: (v: Del) => void, reject!: (e: unknown) => void
    const promise = new Promise<Del>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  const banners = () => [...host.querySelectorAll('.banner')].map((b) => b.textContent ?? '')
  const banner = () => banners().join(' | ')
  // Only a banner that opens with the note's title and "was deleted" claims success; "Could not confirm whether ... was deleted" does not.
  const sawDeleted = () => banners().some((b) => /^\u201c[^\u201d]*\u201d (was deleted|was already deleted)/.test(b))
  const del = async () => { confirmFn.mockReturnValue(true); await click(/^Delete note$/); await flush() }

  it('shows the delete as pending, not done, until the server acknowledges; expects the revision on screen', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A)
    await del()
    expect(deleteNote).toHaveBeenCalledWith({}, 'u1', 'A', 1)
    expect(banner()).toContain('waiting for the server to confirm'); expect(banner()).toContain('has not been deleted yet')
    expect(sawDeleted()).toBe(false)
    expect(titleInput()).not.toBeNull()                                          // still open: nothing is gone yet
    expect(button(/^Delete note$/).hasAttribute('disabled')).toBe(true)          // no second delete while waiting
    w.resolve('deleted'); await flush()
    expect(banner()).toContain('was deleted'); expect(host.textContent).toContain('Select or create a note.')
  })

  it('ignores duplicate clicks while a delete is pending: one confirmation, one request', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await del()
    await click(/^Delete note$/); await click(/^Delete note$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(deleteNote).toHaveBeenCalledTimes(1)
  })

  it('Cancel on the confirmation changes nothing (autosave keeps working)', async () => {
    await openNote(A); await typeTitle('Draft')
    confirmFn.mockReturnValue(false); await click(/^Delete note$/); await flush(800)
    expect(deleteNote).not.toHaveBeenCalled()
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'Draft' }), 1)
  })

  it('refuses a stale delete: says so, shows the newer note, and does not retry by itself', async () => {
    vi.mocked(deleteNote).mockRejectedValue(new ConflictError(note('A', 'Theirs', 2)))
    await openNote(A)
    await del(); await flush(5000)
    expect(deleteNote).toHaveBeenCalledTimes(1)                                    // no silent retry on the newer revision
    expect(banner()).toContain('was not deleted'); expect(banner()).toContain('changed on another device')
    expect(sawDeleted()).toBe(false)
    expect(titleInput().value).toBe('Theirs')                                      // the updated note is what is on screen
    expect(button(/^Delete note$/).hasAttribute('disabled')).toBe(false)
  })

  it('deleting again after reviewing needs a new confirmation and uses the revision that was reviewed', async () => {
    vi.mocked(deleteNote).mockRejectedValueOnce(new ConflictError(note('A', 'Theirs', 2))).mockResolvedValueOnce('deleted')
    await openNote(A); await del()
    confirmFn.mockClear()
    await del()
    expect(confirmFn).toHaveBeenCalledTimes(1)                                     // asked again
    expect(deleteNote).toHaveBeenLastCalledWith({}, 'u1', 'A', 2)
    expect(banner()).toContain('was deleted'); expect(host.textContent).toContain('Select or create a note.')
  })

  it('is blocked again when the note changed again before the second confirmation', async () => {
    vi.mocked(deleteNote)
      .mockRejectedValueOnce(new ConflictError(note('A', 'Theirs', 2)))
      .mockRejectedValueOnce(new ConflictError(note('A', 'Theirs again', 3)))
      .mockResolvedValueOnce('deleted')
    await openNote(A); await del(); await del()
    expect(banner()).toContain('was not deleted'); expect(titleInput().value).toBe('Theirs again')
    await del()
    expect(deleteNote).toHaveBeenNthCalledWith(1, {}, 'u1', 'A', 1)
    expect(deleteNote).toHaveBeenNthCalledWith(2, {}, 'u1', 'A', 2)
    expect(deleteNote).toHaveBeenNthCalledWith(3, {}, 'u1', 'A', 3)
    expect(banner()).toContain('was deleted')
  })

  it('expects the revision the user was looking at, not a newer one the editor had not shown yet', async () => {
    vi.mocked(deleteNote).mockRejectedValue(new ConflictError(note('A', 'Theirs', 3)))
    await openNote(A); await typeTitle('My edit')                                  // draft on rev 1
    await pushNotes([note('A', 'Theirs', 3), B])                                   // newer rev arrives: conflict, not applied
    expect(status()).toContain('Conflict')
    await del()
    expect(deleteNote).toHaveBeenCalledWith({}, 'u1', 'A', 1)                      // not 3
    expect(banner()).toContain('was not deleted')
    expect(titleInput().value).toBe('My edit')                                     // the draft is still there
    expect(status()).toContain('Conflict')                                         // and the existing conflict choices remain
  })

  it('a failed delete (offline) says it was not deleted, keeps the note and its draft, and resumes saving', async () => {
    vi.mocked(deleteNote).mockRejectedValue(Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }))
    await openNote(A); await typeTitle('Draft')
    await del()
    expect(banner()).toContain('was not deleted'); expect(banner()).toContain('could not be reached')
    expect(sawDeleted()).toBe(false)
    expect(titleInput().value).toBe('Draft')
    expect(saveNote).not.toHaveBeenCalled()                                        // nothing written while the delete was undecided
    await flush(800)
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'Draft' }), 1)
  })

  it('can be retried after a failure and then succeeds', async () => {
    vi.mocked(deleteNote).mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' })).mockResolvedValueOnce('deleted')
    await openNote(A); await del(); await del()
    expect(deleteNote).toHaveBeenCalledTimes(2); expect(banner()).toContain('was deleted')
  })

  it('an unconfirmed outcome is reported as unknown, never as success, until the server shows the note gone', async () => {
    vi.mocked(deleteNote).mockRejectedValue(new DeleteOutcomeUnknownError(new Error('lost')))
    await openNote(A); await del()
    expect(banner()).toContain('Could not confirm'); expect(sawDeleted()).toBe(false)
    expect(titleInput()).not.toBeNull()
    await pushNotes([B])                                                           // the live listener shows it is gone
    expect(banner()).toContain('was deleted (confirmed by the server)')
    expect(host.textContent).toContain('Select or create a note.')
  })

  it('an unconfirmed outcome stays unknown while the note is still listed', async () => {
    vi.mocked(deleteNote).mockRejectedValue(new DeleteOutcomeUnknownError(new Error('lost')))
    await openNote(A); await del(); await pushNotes([A, B])
    expect(banner()).toContain('Could not confirm'); expect(sawDeleted()).toBe(false)
  })

  it('a note that was already gone is reported as such, without claiming this attempt deleted it', async () => {
    vi.mocked(deleteNote).mockResolvedValue('already-deleted')
    await openNote(A); await del()
    expect(banner()).toContain('was already deleted')
  })

  describe('sign-out and switching while a delete is unresolved', () => {
    it('does not sign out silently: after a short wait the user must accept that the outcome is unknown', async () => {
      vi.mocked(deleteNote).mockReturnValue(new Promise(() => {}))
      await openNote(A); await del()
      confirmFn.mockClear().mockReturnValue(false)
      await click(/^Sign out$/); await flush(2999)
      expect(confirmFn).not.toHaveBeenCalled(); expect(signOut).not.toHaveBeenCalled()
      await flush(1)
      expect(confirmFn).toHaveBeenCalledTimes(1)
      expect(confirmFn.mock.calls[0][0]).toMatch(/still waiting for the server.*not known whether/s)
      expect(signOut).not.toHaveBeenCalled()
      expect(banner()).toContain('has not been deleted yet'); expect(sawDeleted()).toBe(false)
      confirmFn.mockReturnValue(true)
      await click(/^Sign out$/); await flush(3000)
      expect(signOut).toHaveBeenCalledTimes(1)
      expect(sawDeleted()).toBe(false)                                             // still no claim that it was deleted
    })

    it('signs out without a prompt when the delete finishes within the wait', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del()
      confirmFn.mockClear().mockReturnValue(false)
      await click(/^Sign out$/); await flush(500)
      w.resolve('deleted'); await flush()
      expect(confirmFn).not.toHaveBeenCalled(); expect(signOut).toHaveBeenCalledTimes(1)
    })

    it('after an unconfirmed outcome, signing out asks again and says it may still exist', async () => {
      vi.mocked(deleteNote).mockRejectedValue(new DeleteOutcomeUnknownError(new Error('lost')))
      await openNote(A); await del()
      confirmFn.mockClear().mockReturnValue(false)
      await click(/^Sign out$/); await flush()
      expect(confirmFn).toHaveBeenCalledTimes(1); expect(confirmFn.mock.calls[0][0]).toMatch(/did not confirm.*may still exist/s)
      expect(signOut).not.toHaveBeenCalled()
    })

    it('a definitive failure does not block sign-out (the note simply still exists) and nothing claims otherwise', async () => {
      vi.mocked(deleteNote).mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }))
      await openNote(A); await del()
      confirmFn.mockClear().mockReturnValue(false)
      await click(/^Sign out$/); await flush()
      expect(confirmFn).not.toHaveBeenCalled(); expect(signOut).toHaveBeenCalledTimes(1); expect(sawDeleted()).toBe(false)
    })

    it('switching notes during a pending delete asks the same question', async () => {
      vi.mocked(deleteNote).mockReturnValue(new Promise(() => {}))
      await openNote(A); await del()
      confirmFn.mockClear().mockReturnValue(false)
      await click(/^Note B$/); await flush(3000)
      expect(confirmFn).toHaveBeenCalledTimes(1); expect(confirmFn.mock.calls[0][0]).toMatch(/Switch notes anyway/)
      expect(host.querySelector('.sel')?.textContent).toBe('Note A')
    })
  })

  describe('R1 — the answer arrives after the user switched notes (the original editor is gone)', () => {
    const switchToB = async () => {            // accepts the "delete still waiting" question
      confirmFn.mockClear().mockReturnValue(true)
      await click(/^Note B$/); await flush(3000)
      confirmFn.mockClear().mockReturnValue(false)
    }

    it('a stale rejection still ends the pending state, keeps the newer note, and leaves Note B usable', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del()
      expect(banner()).toContain('has not been deleted yet')
      await switchToB()
      expect(host.querySelector('.sel')?.textContent).toBe('Note B')
      expect(banner()).toContain('has not been deleted yet')                      // still genuinely pending
      await pushNotes([note('A', 'Theirs', 2), B])                               // Note A advanced on the server
      w.reject(new ConflictError(note('A', 'Theirs', 2))); await flush()         // the stale rejection finally arrives
      expect(banner()).toContain('was not deleted'); expect(banner()).toContain('Open it again to review')
      expect(banner()).not.toContain('has not been deleted yet')                 // no longer pending
      expect(sawDeleted()).toBe(false)
      expect(button(/^Delete note$/).hasAttribute('disabled')).toBe(false)       // controls usable again
      expect(titleInput().value).toBe('Note B')
      expect(deleteNote).toHaveBeenCalledTimes(1)                                // nothing retried on the newer revision
      // Note B is usable: editing it autosaves to Note B, and sign-out no longer asks about an unresolved delete
      await typeTitle('B edited'); await flush(800)
      expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'B', expect.objectContaining({ title: 'B edited' }), 1)
      await click(/^Sign out$/); await flush()
      expect(confirmFn).not.toHaveBeenCalled(); expect(signOut).toHaveBeenCalledTimes(1)
    })

    it('the conflict can then be reviewed and resolved: reopen the note, see the newer revision, confirm again', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValueOnce(w.promise).mockResolvedValueOnce('deleted')
      await openNote(A); await del(); await switchToB()
      await pushNotes([note('A', 'Theirs', 2), B])
      w.reject(new ConflictError(note('A', 'Theirs', 2))); await flush()
      await openNote(note('A', 'Theirs', 2))                                      // the user goes back to review it
      expect(titleInput().value).toBe('Theirs')
      confirmFn.mockClear()
      await del()
      expect(confirmFn).toHaveBeenCalledTimes(1)                                  // a fresh confirmation
      expect(deleteNote).toHaveBeenLastCalledWith({}, 'u1', 'A', 2)               // the reviewed revision, explicitly confirmed
      expect(banner()).toContain('was deleted')
    })

    it('a draft held by the unmounted editor is not written after a refused delete', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await typeTitle('A draft'); await del(); await switchToB()
      w.reject(new ConflictError(note('A', 'Theirs', 2))); await flush(5000)
      expect(saveNote).not.toHaveBeenCalled()                                    // the discarded draft is not resurrected
      expect(banner()).toContain('was not deleted')
    })

    it('a failure that arrives late ends the pending state too, with controls usable', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del(); await switchToB()
      w.reject(Object.assign(new Error('offline'), { code: 'unavailable' })); await flush()
      expect(banner()).toContain('could not be reached'); expect(banner()).not.toContain('has not been deleted yet')
      expect(button(/^Delete note$/).hasAttribute('disabled')).toBe(false)
    })

    it('a success that arrives late is reported once, and leaves Note B open', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del(); await switchToB()
      w.resolve('deleted'); await flush()
      expect(banner()).toContain('was deleted'); expect(titleInput().value).toBe('Note B')
      expect(host.querySelector('.sel')?.textContent).toBe('Note B')
    })

    it('ordering: the answer arriving before the switch behaves as before (conflict shown on the open note)', async () => {
      vi.mocked(deleteNote).mockRejectedValue(new ConflictError(note('A', 'Theirs', 2)))
      await openNote(A); await del()
      expect(banner()).toContain('Review the newer version first')
      expect(titleInput().value).toBe('Theirs')
      await click(/^Note B$/); await flush()
      expect(confirmFn).toHaveBeenCalledTimes(1)                                  // only the delete confirmation: nothing unresolved
      expect(host.querySelector('.sel')?.textContent).toBe('Note B')
    })

    it('even if building the notice itself throws, the delete cannot stay pending', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del()
      w.reject({ get code(): string { throw new Error('boom') } }); await flush()     // failureReason() throws while reading the error
      expect(banner()).not.toContain('has not been deleted yet'); expect(banner()).toContain('something went wrong')
      expect(sawDeleted()).toBe(false)
      expect(button(/^Delete note$/).hasAttribute('disabled')).toBe(false)
      confirmFn.mockReturnValue(true)                                                   // the attempt's promise must not reject:
      await click(/^Sign out$/); await flush(3000)                                      // leaving awaits it, and still works
      expect(signOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('R2 — an unconfirmed outcome and the listener may arrive in either order', () => {
    const unknown = () => new DeleteOutcomeUnknownError(new Error('lost'))

    it('A: notice first, authoritative confirmation afterwards -> resolved', async () => {
      vi.mocked(deleteNote).mockRejectedValue(unknown())
      await openNote(A); await del()
      expect(banner()).toContain('Could not confirm')
      await pushNotes([B])                                                        // server data: the note is gone
      expect(banner()).toContain('was deleted (confirmed by the server)'); expect(banner()).not.toContain('Could not confirm')
      expect(host.textContent).toContain('Select or create a note.')
    })

    it('B: authoritative confirmation first, notice afterwards -> no stale unknown notice', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del()
      await pushNotes([B])                                                        // the listener already shows it gone ...
      expect(banner()).toContain('has not been deleted yet')                       // ... but the local operation has not answered
      w.reject(unknown()); await flush()                                          // ... then it enters its unknown path
      expect(banner()).toContain('was deleted (confirmed by the server)'); expect(banner()).not.toContain('Could not confirm')
      expect(button(/^Delete note$/)).toBeUndefined()                              // the note is closed
    })

    it('B (user already on another note): same reconciliation', async () => {
      const w = pendingDelete()
      vi.mocked(deleteNote).mockReturnValue(w.promise)
      await openNote(A); await del()
      confirmFn.mockClear().mockReturnValue(true); await click(/^Note B$/); await flush(3000)
      await pushNotes([B]); w.reject(unknown()); await flush()
      expect(banner()).toContain('was deleted (confirmed by the server)')
      expect(titleInput().value).toBe('Note B')
    })

    it('C: no authoritative confirmation (the note is still listed) -> stays unknown, never success', async () => {
      vi.mocked(deleteNote).mockRejectedValue(unknown())
      await openNote(A); await del(); await pushNotes([A, B]); await flush(10000)
      expect(banner()).toContain('Could not confirm'); expect(sawDeleted()).toBe(false)
    })

    it('C: a disappearance seen only through the cache is not confirmation', async () => {
      vi.mocked(deleteNote).mockRejectedValue(unknown())
      await openNote(A); await del()
      await pushNotes([B], true, false)
      expect(banner()).toContain('Could not confirm'); expect(sawDeleted()).toBe(false)
      await pushNotes([B], false, false)                                         // the server confirms later
      expect(banner()).toContain('was deleted (confirmed by the server)')
    })

    it('C: an optimistic local change (unacknowledged pending writes) is not confirmation', async () => {
      vi.mocked(deleteNote).mockRejectedValue(unknown())
      await openNote(A); await del()
      await pushNotes([B], false, true)                                          // fromCache false, but a local write is pending
      expect(banner()).toContain('Could not confirm'); expect(sawDeleted()).toBe(false)
      await pushNotes([B], false, false)
      expect(banner()).toContain('was deleted (confirmed by the server)')
    })

    it('a definitive failure is never turned into a success by the listener', async () => {
      vi.mocked(deleteNote).mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }))
      await openNote(A); await del(); await pushNotes([B])
      expect(banner()).toContain('was not deleted'); expect(sawDeleted()).toBe(false)
    })
  })
})

describe('A1 — edits made while a delete is pending are not lost by leaving', () => {
  type Del = 'deleted' | 'already-deleted'
  const pendingDelete = () => {
    let resolve!: (v: Del) => void, reject!: (e: unknown) => void
    const promise = new Promise<Del>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  const banners = () => [...host.querySelectorAll('.banner')].map((b) => b.textContent ?? '').join(' | ')
  const startDelete = async () => { confirmFn.mockReturnValue(true); await click(/^Delete note$/); await flush() }

  it('switching notes is deferred: no prompt that discards, the note and its draft stay open', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('My edit'); await startDelete()
    confirmFn.mockClear().mockReturnValue(true)           // even an eager "OK" must not be able to discard here
    await click(/^Note B$/); await flush(3000)
    expect(confirmFn).not.toHaveBeenCalled()
    expect(host.querySelector('.sel')?.textContent).toBe('Note A')
    expect(titleInput().value).toBe('My edit')
    expect(banners()).toContain('Staying on this note'); expect(banners()).toContain('has not been deleted yet')
    expect(button(/^Note B$/).hasAttribute('disabled')).toBe(false)   // navigation is usable again right away
  })

  it('the reported scenario: edit during a pending delete, try to switch, the delete is refused -> the draft is still there with the usual conflict choices', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('My edit'); await startDelete()
    await click(/^Note B$/); await flush(3000)
    w.reject(new ConflictError(note('A', 'Theirs', 2))); await flush()
    expect(banners()).toContain('was not deleted'); expect(banners()).not.toContain('Staying on this note')
    expect(titleInput().value).toBe('My edit')            // the draft survived the refusal
    expect(status()).toContain('Conflict')
    expect(saveNote).not.toHaveBeenCalled()                // and nothing was overwritten
    // leaving is protected by the normal unsaved-changes question again
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Note B$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(confirmFn.mock.calls[0][0]).toMatch(/changes that could not be saved/)
    expect(titleInput().value).toBe('My edit')
  })

  it('once the delete answers "not deleted" without a conflict (offline), the draft is saved as usual', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('My edit'); await startDelete()
    await click(/^Note B$/); await flush(3000)
    w.reject(Object.assign(new Error('offline'), { code: 'unavailable' })); await flush(800)
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'My edit' }), 1)
  })

  it('if the delete is confirmed the note is gone and switching works again', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('My edit'); await startDelete()
    await click(/^Note B$/); await flush(3000)
    w.resolve('deleted'); await flush()
    expect(banners()).toContain('was deleted'); expect(banners()).not.toContain('Staying on this note')
    await pushNotes([B]); await openNote(B)
    expect(titleInput().value).toBe('Note B')
  })

  it('a delete that answers during the short wait lets the switch continue normally', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await typeTitle('My edit'); await startDelete()
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Note B$/); await flush(500)
    w.reject(Object.assign(new Error('offline'), { code: 'unavailable' })); await flush()
    expect(confirmFn).not.toHaveBeenCalled()               // the draft was saved, so nothing needs asking
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'My edit' }), 1)
    expect(host.querySelector('.sel')?.textContent).toBe('Note B')
  })

  it('sign-out explains that the held edits are lost even if the delete is refused; Cancel keeps them', async () => {
    vi.mocked(deleteNote).mockReturnValue(new Promise(() => {}))
    await openNote(A); await typeTitle('My edit'); await startDelete()
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Sign out$/); await flush(3000)
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0][0]).toMatch(/unsaved edits.*held until it answers.*lost, even if the delete is then refused/s)
    expect(signOut).not.toHaveBeenCalled(); expect(titleInput().value).toBe('My edit')
    confirmFn.mockReturnValue(true)
    await click(/^Sign out$/); await flush(3000)
    expect(signOut).toHaveBeenCalledTimes(1)               // only an explicit OK discards
  })

  it('without edits, a pending delete still asks before switching (outcome unknown) and Cancel stays', async () => {
    vi.mocked(deleteNote).mockReturnValue(new Promise(() => {}))
    await openNote(A); await startDelete()
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Note B$/); await flush(3000)
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(confirmFn.mock.calls[0][0]).toMatch(/not known whether/)
    expect(host.querySelector('.sel')?.textContent).toBe('Note A')
  })

  it('a draft on another note is saved (or asked about) even while a delete is unresolved', async () => {
    const w = pendingDelete()
    vi.mocked(deleteNote).mockReturnValue(w.promise)
    await openNote(A); await startDelete()
    confirmFn.mockClear().mockReturnValue(true); await click(/^Note B$/); await flush(3000)   // accepts the unknown outcome
    expect(host.querySelector('.sel')?.textContent).toBe('Note B')
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    await typeTitle('B draft'); confirmFn.mockClear().mockReturnValue(false)
    await click(/^Sign out$/); await flush(3000)
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0][0]).toMatch(/still waiting for the server/); expect(confirmFn.mock.calls[0][0]).toMatch(/could not be saved/)
    expect(signOut).not.toHaveBeenCalled(); expect(titleInput().value).toBe('B draft')
  })
})

describe('A2 — an unconfirmed delete stays visible until the server settles it', () => {
  const unknown = () => new DeleteOutcomeUnknownError(new Error('lost'))
  const banners = () => [...host.querySelectorAll('.banner')].map((b) => b.textContent ?? '').join(' | ')
  const claimsDeleted = () => [...host.querySelectorAll('.banner')].some((b) => /^\u201c[^\u201d]*\u201d (was|were) (already )?deleted/.test(b.textContent ?? ''))
  const del = async () => { confirmFn.mockReturnValue(true); await click(/^Delete note$/); await flush() }
  const sidebarA = () => [...host.querySelectorAll('.sidebar li button')].find((b) => /Note A/.test(b.textContent ?? ''))!

  it('dismissing the notice keeps a persistent indicator (banner and sidebar marker)', async () => {
    vi.mocked(deleteNote).mockRejectedValue(unknown())
    await openNote(A); await del()
    expect(banners()).toContain('Could not confirm')
    await click(/^Dismiss$/)
    expect(banners()).not.toContain('Could not confirm')
    expect(banners()).toContain('Still unconfirmed'); expect(banners()).toContain('Note A')
    expect(sidebarA().textContent).toContain('delete unconfirmed')
    expect(claimsDeleted()).toBe(false)
  })

  it('after dismissal, signing out still says the outcome is unknown', async () => {
    vi.mocked(deleteNote).mockRejectedValue(unknown())
    await openNote(A); await del(); await click(/^Dismiss$/)
    confirmFn.mockClear().mockReturnValue(true); await click(/^Note B$/); await flush()    // leaving the note itself asks (accepted here) ...
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Sign out$/); await flush()                                              // ... and so does leaving the session
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(confirmFn.mock.calls[0][0]).toMatch(/did not confirm whether .Note A. was deleted.*may still exist/s)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('leaving the unconfirmed note asks; switching between other notes does not', async () => {
    const C = note('C', 'Note C')
    vi.mocked(deleteNote).mockRejectedValue(unknown())
    await pushNotes([A, B, C]); await openNote(A); await del(); await click(/^Dismiss$/)
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Note B$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(host.querySelector('.sel')?.textContent).toMatch(/Note A/)   // Cancel stays
    confirmFn.mockClear().mockReturnValue(true)
    await click(/^Note B$/); await flush()
    expect(host.querySelector('.sel')?.textContent).toBe('Note B')
    confirmFn.mockClear().mockReturnValue(false)
    await click(/^Note C$/); await flush()
    expect(confirmFn).not.toHaveBeenCalled(); expect(host.querySelector('.sel')?.textContent).toBe('Note C')
  })

  it('a dismissed uncertainty is still reconciled by a later server-authoritative snapshot', async () => {
    vi.mocked(deleteNote).mockRejectedValue(unknown())
    await openNote(A); await del(); await click(/^Dismiss$/)
    await pushNotes([B], true, false)                                                     // cache only: not confirmation
    expect(banners()).toContain('Still unconfirmed'); expect(claimsDeleted()).toBe(false)
    await pushNotes([B], false, false)
    expect(banners()).toContain('was deleted (confirmed by the server)'); expect(banners()).not.toContain('Still unconfirmed')
  })

  it('a second unconfirmed delete does not erase the first', async () => {
    vi.mocked(deleteNote).mockRejectedValue(unknown())
    await openNote(A); await del()
    await openNote(B)                                  // the notice for A is not a blocker for an unrelated switch
    await del()
    expect(banners()).toContain('Still unconfirmed'); expect(banners()).toContain('Note A')
    expect(banners()).toContain('Could not confirm'); expect(banners()).toContain('Note B')
    await pushNotes([A], false, false)                  // the server shows B gone, A still there
    expect(banners()).toContain('Note B” was deleted (confirmed by the server)')
    expect(banners()).toContain('Still unconfirmed'); expect(banners()).toContain('Note A')
  })

  it('deleting again gives a definite answer and ends the uncertainty', async () => {
    vi.mocked(deleteNote).mockRejectedValueOnce(unknown()).mockResolvedValueOnce('deleted')
    await openNote(A); await del(); await click(/^Dismiss$/)
    await del()
    expect(banners()).not.toContain('Still unconfirmed'); expect(banners()).toContain('was deleted')
  })

  it('a refusal that shows the note exists (changed elsewhere) ends the uncertainty; a plain failure does not', async () => {
    vi.mocked(deleteNote).mockRejectedValueOnce(unknown())
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
      .mockRejectedValueOnce(new ConflictError(note('A', 'Theirs', 2)))
    await openNote(A); await del()
    await del()                                                                           // offline: the earlier attempt is still unresolved
    expect(banners()).toContain('could not be reached'); expect(banners()).toContain('Still unconfirmed')
    await del()                                                                           // the server answered with the note
    expect(banners()).toContain('changed on another device'); expect(banners()).not.toContain('Still unconfirmed')
    expect(sidebarA().textContent).not.toContain('delete unconfirmed')
  })

  it('a cached or optimistic disappearance never produces success, with or without the notice', async () => {
    vi.mocked(deleteNote).mockRejectedValue(unknown())
    await openNote(A); await del(); await click(/^Dismiss$/)
    await pushNotes([B], false, true)
    expect(claimsDeleted()).toBe(false); expect(banners()).toContain('Still unconfirmed')
  })

  it('does not replace a pending delete notice while reconciling', async () => {
    vi.mocked(deleteNote).mockRejectedValueOnce(unknown()).mockReturnValueOnce(new Promise(() => {}))
    await openNote(A); await del()
    await openNote(B); await del()                                                        // B pending
    await pushNotes([B], false, false)                                                    // A is gone on the server
    expect(banners()).toContain('has not been deleted yet'); expect(banners()).toContain('Still unconfirmed')
  })
})

describe('search', () => {
  const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
  const withBody = (id: string, title: string, ...lines: string[]): Note =>
    ({ ...note(id, title), content: JSON.stringify({ type: 'doc', content: lines.map(para) }) })
  const budget = withBody('N1', 'Weekly plan', 'Review the Budget spreadsheet')
  const garden = withBody('N2', 'Garden', 'plant tomatoes')
  const searchBox = () => host.querySelector<HTMLInputElement>('input[type="search"]')!
  const typeQuery = (v: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchBox(), v)
    searchBox().dispatchEvent(new Event('input', { bubbles: true }))
  })
  const listed = () => [...host.querySelectorAll('.sidebar li button')].map((b) => b.textContent)
  beforeEach(async () => { await pushNotes([budget, garden, A]) })

  it('has a labelled search box, and the normal list while it is empty', () => {
    expect(searchBox().getAttribute('aria-label')).toBe('Search notes')
    expect(listed()).toEqual(['Weekly plan', 'Garden', 'Note A'])
  })
  it('finds notes by title, case-insensitively', async () => {
    await typeQuery('GARD'); expect(listed()).toEqual(['Garden'])
  })
  it('finds notes by body text from the structured document', async () => {
    await typeQuery('budget spreadsheet'); expect(listed()).toEqual(['Weekly plan'])
    expect(host.textContent).toContain('1 of 3 notes')
  })
  it('does not match document structure (node names, JSON keys)', async () => {
    await typeQuery('paragraph'); expect(listed()).toEqual([])
    await typeQuery('content'); expect(listed()).toEqual([])
  })
  it('clearing the query brings back the whole list', async () => {
    await typeQuery('garden'); await typeQuery(''); expect(listed()).toEqual(['Weekly plan', 'Garden', 'Note A'])
  })
  it('says "no matches" differently from "no notes yet", and offers to clear the search', async () => {
    await typeQuery('zebra')
    expect(host.textContent).toContain('No notes match “zebra”'); expect(host.textContent).not.toContain('No notes yet')
    await click(/^Clear search$/)
    expect(searchBox().value).toBe(''); expect(listed()).toHaveLength(3)
    await pushNotes([]); await typeQuery('zebra')
    expect(host.textContent).toContain('No notes yet.'); expect(host.textContent).not.toContain('No notes match')
  })
  it('results follow changes that arrive: an edit, a new note and a deletion', async () => {
    await typeQuery('tomatoes'); expect(listed()).toEqual(['Garden'])
    await pushNotes([budget, withBody('N2', 'Garden', 'plant beans'), A]); expect(listed()).toEqual([])
    await pushNotes([budget, withBody('N3', 'Recipes', 'Tomatoes on toast'), A]); expect(listed()).toEqual(['Recipes'])
    await pushNotes([budget, A]); expect(listed()).toEqual([])
  })
  it('never writes, and never disturbs the open note or its unsaved edits', async () => {
    await openNote(A); await typeTitle('Draft title')
    await typeQuery('zebra')
    expect(titleInput().value).toBe('Draft title'); expect(host.querySelector('.sel')).toBeNull()      // open, though not listed
    expect(confirmFn).not.toHaveBeenCalled()
    await typeQuery(''); await flush(800)
    expect(titleInput().value).toBe('Draft title')
    expect(saveNote).toHaveBeenCalledTimes(1)                                                          // only the normal autosave
    expect(deleteNote).not.toHaveBeenCalled()
  })
  it('a note that is open stays usable from a filtered list, and leaving it keeps the usual protection', async () => {
    await typeQuery('garden'); await openNote(garden)
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))
    await typeTitle('Garden 2'); await typeQuery('')
    await click(/^Weekly plan$/); await flush()
    expect(confirmFn).toHaveBeenCalledTimes(1); expect(titleInput().value).toBe('Garden 2')
  })
  it('a new note is shown even when a search was active', async () => {
    vi.mocked(createNote).mockResolvedValue('N9')
    await typeQuery('garden')
    await click(/^\+ New note$/); await flush()
    expect(searchBox().value).toBe('')
    await pushNotes([budget, garden, A, { ...note('N9', ''), updatedAt: 99 }])
    expect(listed()).toContain('Untitled')
  })
})

describe('appearance settings', () => {
  const html = document.documentElement
  const settingsBtn = () => button(/^Settings$/)
  const open = async () => { await click(/^Settings$/); await flush() }
  const radio = (name: string, value: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!
  const choose = (name: string, value: string) => act(async () => { radio(name, value).click() })
  const prefStatus = () => host.querySelector('.prefs-status')?.textContent ?? ''
  const deferredSave = () => {
    let resolve!: () => void, reject!: (e: unknown) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('applies the defaults to the page and shows no settings panel until asked', () => {
    expect([html.dataset.theme, html.dataset.bg, html.dataset.font]).toEqual(['light', 'plain', 'medium'])
    expect(host.querySelector('#settings')).toBeNull()
    expect(settingsBtn().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens an accessible panel with theme, background and font size as radio groups', async () => {
    await open()
    expect(settingsBtn().getAttribute('aria-expanded')).toBe('true')
    const groups = [...host.querySelectorAll('#settings fieldset legend')].map((l) => l.textContent)
    expect(groups).toEqual(['Theme', 'Background', 'Note text size'])
    expect(host.querySelectorAll('input[name="theme"]')).toHaveLength(2)
    expect(host.querySelectorAll('input[name="background"]')).toHaveLength(5)
    expect(host.querySelectorAll('input[name="fontSize"]')).toHaveLength(4)
    expect(radio('theme', 'light').checked).toBe(true)
    expect(document.activeElement).toBe(radio('theme', 'light'))    // keyboard users land inside the panel
  })

  it('Escape closes the panel and returns focus to the Settings button', async () => {
    await open()
    await act(async () => { radio('theme', 'light').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('#settings')).toBeNull(); expect(document.activeElement).toBe(settingsBtn())
  })

  it('choosing a theme, background and size applies at once and saves only the changed field', async () => {
    await open()
    await choose('theme', 'dark'); expect(html.dataset.theme).toBe('dark')
    await choose('background', 'sky'); expect(html.dataset.bg).toBe('sky')
    await choose('fontSize', 'xlarge'); expect(html.dataset.font).toBe('xlarge')
    await flush()
    expect(vi.mocked(savePreferences).mock.calls.map((c) => c[2])).toEqual([{ theme: 'dark' }, { background: 'sky' }, { fontSize: 'xlarge' }])
    expect(radio('theme', 'dark').checked).toBe(true); expect(prefStatus()).toContain('Saved')
  })

  it('does not say "saved" before the server acknowledged: saving, then saved', async () => {
    const w = deferredSave(); vi.mocked(savePreferences).mockReturnValue(w.promise)
    await open(); await choose('theme', 'dark')
    expect(prefStatus()).toContain('Saving'); expect(prefStatus()).not.toContain('Saved')
    w.resolve(); await flush()
    expect(prefStatus()).toContain('Saved to your account')
  })

  it('a failed save is shown as not saved with a Retry that works; the choice stays on screen meanwhile', async () => {
    vi.mocked(savePreferences).mockRejectedValueOnce(new Error('offline'))
    await open(); await choose('theme', 'dark'); await flush()
    expect(prefStatus()).toContain('Not saved'); expect(prefStatus()).not.toContain('Saved to your account')
    expect(host.querySelector('#settings [role="alert"]')?.textContent).toContain('offline')
    expect(html.dataset.theme).toBe('dark')
    await click(/^Retry$/); await flush()
    expect(savePreferences).toHaveBeenCalledTimes(2); expect(prefStatus()).toContain('Saved to your account')
  })

  it('preferences stored by another session of the account are applied live', async () => {
    await act(async () => { h.pushPrefs({ theme: 'dark', background: 'mint', fontSize: 'large' }) })
    expect([html.dataset.theme, html.dataset.bg, html.dataset.font]).toEqual(['dark', 'mint', 'large'])
  })

  it('a remote update does not overwrite a choice that is not saved yet', async () => {
    const w = deferredSave(); vi.mocked(savePreferences).mockReturnValue(w.promise)
    await open(); await choose('theme', 'dark')
    await act(async () => { h.pushPrefs({ theme: 'light', background: 'rose', fontSize: 'small' }) })
    expect([html.dataset.theme, html.dataset.bg, html.dataset.font]).toEqual(['dark', 'rose', 'small'])
    w.resolve(); await flush()
    expect(html.dataset.theme).toBe('dark')
  })

  it('editing still works after changing appearance', async () => {
    await open(); await choose('theme', 'dark'); await choose('fontSize', 'large')
    await openNote(A); await typeTitle('Dark and large'); await flush(800)
    expect(saveNote).toHaveBeenCalledWith({}, 'u1', 'A', expect.objectContaining({ title: 'Dark and large' }), 1)
  })

  it('a load failure keeps the defaults and says so', async () => {
    let fail!: (e: Error) => void
    vi.mocked(subscribePreferences).mockImplementation(((_d: unknown, _u: string, _ok: unknown, onError: (e: Error) => void) => { fail = onError; return () => {} }) as any)
    await act(async () => { root.unmount() })
    root = createRoot(host); await act(async () => { root.render(<App />) }); await flush()
    await act(async () => { fail(new Error('permission-denied')) })
    expect(host.textContent).toContain('Could not load your appearance settings'); expect(html.dataset.theme).toBe('light')
  })

  it('signing out (unmounting the signed-in view) removes the user\'s appearance from the page', async () => {
    await act(async () => { h.pushPrefs({ theme: 'dark', background: 'rose', fontSize: 'xlarge' }) })
    expect(html.dataset.theme).toBe('dark')
    await act(async () => { root.unmount() })
    expect([html.dataset.theme, html.dataset.bg, html.dataset.font]).toEqual([undefined, undefined, undefined])
    root = createRoot(host)    // the afterEach hook unmounts a live root
    await act(async () => { root.render(<div />) })
  })

  it('stops listening when the view unmounts', async () => {
    const stop = vi.fn()
    vi.mocked(subscribePreferences).mockImplementation((() => stop) as any)
    await act(async () => { root.unmount() })
    root = createRoot(host); await act(async () => { root.render(<App />) }); await flush()
    await act(async () => { root.unmount() })
    expect(stop).toHaveBeenCalled()
    root = createRoot(host); await act(async () => { root.render(<div />) })
  })
})

describe('A4 — reconciling an unconfirmed delete never discards an unsaved draft', () => {
  const banners = () => [...host.querySelectorAll('.banner')].map((b) => b.textContent ?? '').join(' | ')
  const del = async () => { confirmFn.mockReturnValue(true); await click(/^Delete note$/); await flush() }

  it('a draft typed during the delete is kept when the server later shows the note gone (the usual remote-deletion choices)', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('offline'))                       // the draft cannot be saved
    vi.mocked(deleteNote).mockRejectedValue(new DeleteOutcomeUnknownError(new Error('lost')))
    await openNote(A); await typeTitle('Typed during the delete'); await del()
    expect(banners()).toContain('Could not confirm')
    await pushNotes([B])                                                              // server-authoritative: A is gone
    expect(banners()).toContain('was deleted (confirmed by the server)')              // the outcome is reported ...
    expect(titleInput().value).toBe('Typed during the delete')                        // ... but the draft was not thrown away
    expect(host.textContent).toContain('deleted on another device'); expect(button(/^Restore my draft$/)).toBeDefined()
    await click(/^Discard my draft$/); await flush()                                   // only an explicit choice closes it
    expect(host.textContent).toContain('Select or create a note.')
  })

  it('a clean editor is still closed when the server shows the note gone', async () => {
    vi.mocked(deleteNote).mockRejectedValue(new DeleteOutcomeUnknownError(new Error('lost')))
    await openNote(A); await del(); await pushNotes([B])
    expect(host.textContent).toContain('Select or create a note.')
  })
})
