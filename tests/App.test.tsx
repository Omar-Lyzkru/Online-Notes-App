import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signOut } from 'firebase/auth'
import App from '../src/App'
import { ConflictError, DeleteOutcomeUnknownError, EMPTY_DOC, deleteNote, saveNote, subscribeNotes, type Note } from '../src/notesApi'

/**
 * UI-level regression tests: the real App and Editor run in jsdom (not a real browser). Firebase and
 * the Tiptap view layer are replaced with controllable fakes; no network or emulator is involved.
 */
const h = vi.hoisted(() => ({
  push: (_: unknown[], _cache?: boolean, _pending?: boolean) => {},
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
