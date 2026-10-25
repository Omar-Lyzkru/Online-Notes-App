import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveController } from '../src/saveController'
import { ConflictError, type Note } from '../src/notesApi'

const d = (t: string) => ({ title: t, content: '{}' })
const note = (rev: number): Note => ({ id: 'n', title: 'remote', content: '{}', rev, updatedAt: 0 })

beforeEach(() => vi.useFakeTimers())

describe('SaveController', () => {
  it('debounces typing into one write and only reports saved after the ack', async () => {
    let resolve!: (rev: number) => void
    const save = vi.fn(() => new Promise<number>((r) => (resolve = r)))
    const c = new SaveController(1, save, () => {}, 800)
    c.edit(d('a')); c.edit(d('ab')); c.edit(d('abc'))
    expect(c.state).toBe('dirty')
    await vi.advanceTimersByTimeAsync(799)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(d('abc'), 1)
    expect(c.state).toBe('saving') // write pending: not "saved"
    resolve(2); await vi.advanceTimersByTimeAsync(0)
    expect(c.state).toBe('saved'); expect(c.baseRev).toBe(2)
  })

  it('keeps the draft on failure and retries from the same base', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(2)
    const c = new SaveController(1, save, () => {}, 10)
    c.edit(d('x')); await vi.advanceTimersByTimeAsync(10)
    expect(c.state).toBe('error'); expect(c.draft).toEqual(d('x'))
    await c.flush()
    expect(save).toHaveBeenLastCalledWith(d('x'), 1)
    expect(c.state).toBe('saved')
  })

  it('edits made while saving trigger a follow-up save with the new revision', async () => {
    let resolve!: (rev: number) => void
    const save = vi.fn(() => new Promise<number>((r) => (resolve = r)))
    const c = new SaveController(1, save, () => {}, 10)
    c.edit(d('a')); await vi.advanceTimersByTimeAsync(10)
    c.edit(d('ab'))
    expect(c.state).toBe('saving')
    resolve(2); await vi.advanceTimersByTimeAsync(0)
    expect(c.state).toBe('dirty')
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenLastCalledWith(d('ab'), 2)
  })

  it('remote update never overwrites an unsaved draft; it raises a conflict', () => {
    const c = new SaveController(1, vi.fn(), () => {}, 800)
    c.edit(d('mine'))
    expect(c.onRemote(note(2))).toBe('conflict')
    expect(c.state).toBe('conflict'); expect(c.draft).toEqual(d('mine'))
    expect(c.remote?.rev).toBe(2)
  })

  it('applies remote updates when clean, ignores own echo', () => {
    const c = new SaveController(2, vi.fn(), () => {}, 800)
    expect(c.onRemote(note(2))).toBe('ignore')
    expect(c.onRemote(note(3))).toBe('apply'); expect(c.baseRev).toBe(3)
    expect(c.onRemote(null)).toBe('apply')
  })

  it('stale write surfaces as conflict; keepMine overwrites only on explicit choice', async () => {
    const save = vi.fn().mockRejectedValueOnce(new ConflictError(note(5))).mockResolvedValueOnce(6)
    const c = new SaveController(1, save, () => {}, 10)
    c.edit(d('mine')); await vi.advanceTimersByTimeAsync(10)
    expect(c.state).toBe('conflict'); expect(save).toHaveBeenCalledTimes(1)
    await c.flush(); expect(save).toHaveBeenCalledTimes(1) // no silent retry
    c.keepMine(); await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenLastCalledWith(d('mine'), 5)
    expect(c.state).toBe('saved')
  })

  it('useRemote discards the draft and adopts the remote revision', () => {
    const c = new SaveController(1, vi.fn(), () => {}, 800)
    c.edit(d('mine')); c.onRemote(note(4))
    expect(c.useRemote()?.rev).toBe(4)
    expect(c.draft).toBeNull(); expect(c.baseRev).toBe(4); expect(c.state).toBe('saved')
  })

  it('remote deletion with a draft keeps the draft; keepMine recreates', async () => {
    const save = vi.fn().mockResolvedValue(1)
    const c = new SaveController(3, save, () => {}, 800)
    c.edit(d('mine')); expect(c.onRemote(null)).toBe('conflict')
    c.keepMine(); await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledWith(d('mine'), null)
  })

  describe('settle', () => {
    it('flushes a dirty draft and resolves saved only after the ack', async () => {
      let resolve!: (rev: number) => void
      const save = vi.fn(() => new Promise<number>((r) => (resolve = r)))
      const c = new SaveController(1, save, () => {}, 800)
      c.edit(d('a'))
      let done: string | undefined
      void c.settle().then((s) => (done = s))
      await vi.advanceTimersByTimeAsync(0)
      expect(save).toHaveBeenCalledTimes(1) // no waiting for the debounce
      expect(done).toBeUndefined()
      resolve(2); await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe('saved'); expect(c.draft).toBeNull()
    })

    it('waits for a write already in flight and follows edits made meanwhile', async () => {
      const resolvers: ((rev: number) => void)[] = []
      const save = vi.fn(() => new Promise<number>((r) => resolvers.push(r)))
      const c = new SaveController(1, save, () => {}, 10)
      c.edit(d('a')); await vi.advanceTimersByTimeAsync(10) // saving
      c.edit(d('ab'))
      let done: string | undefined
      void c.settle().then((s) => (done = s))
      resolvers[0](2); await vi.advanceTimersByTimeAsync(0)
      expect(save).toHaveBeenLastCalledWith(d('ab'), 2) // the follow-up goes out without the debounce
      expect(done).toBeUndefined()
      resolvers[1](3); await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe('saved'); expect(c.baseRev).toBe(3)
    })

    it('retries a failed draft once, then reports error and keeps the draft', async () => {
      const save = vi.fn().mockRejectedValue(new Error('offline'))
      const c = new SaveController(1, save, () => {}, 10)
      c.edit(d('x')); await vi.advanceTimersByTimeAsync(10)
      expect(c.state).toBe('error'); expect(save).toHaveBeenCalledTimes(1)
      expect(await c.settle()).toBe('error')
      expect(save).toHaveBeenCalledTimes(2)
      expect(c.draft).toEqual(d('x'))
    })

    it('leaves a conflict for the user and never writes over it', async () => {
      const save = vi.fn()
      const c = new SaveController(1, save, () => {}, 800)
      c.edit(d('mine')); c.onRemote(note(2))
      expect(await c.settle()).toBe('conflict')
      expect(save).not.toHaveBeenCalled(); expect(c.draft).toEqual(d('mine'))
    })

    it('resolves immediately when there is nothing to save', async () => {
      const c = new SaveController(1, vi.fn(), () => {}, 800)
      expect(await c.settle()).toBe('saved')
    })
  })

  describe('abandon (note deleted on purpose)', () => {
    it('cancels the pending autosave and ignores later edits and remote data', async () => {
      const save = vi.fn()
      const c = new SaveController(1, save, () => {}, 800)
      c.edit(d('x')); await c.abandon()
      c.edit(d('y')); expect(c.onRemote(note(2))).toBe('ignore')
      await vi.advanceTimersByTimeAsync(5000); await c.flush()
      expect(save).not.toHaveBeenCalled(); expect(c.draft).toBeNull()
    })

    it('resolves only after a write in flight finished, and then writes nothing more', async () => {
      let resolve!: (rev: number) => void
      const save = vi.fn(() => new Promise<number>((r) => (resolve = r)))
      const c = new SaveController(null, save, () => {}, 10) // recreating a remotely deleted note
      c.edit(d('x')); await vi.advanceTimersByTimeAsync(10)
      c.edit(d('xy')) // would normally trigger a follow-up save
      let done = false
      void c.abandon().then(() => (done = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(false)
      resolve(1); await vi.advanceTimersByTimeAsync(100)
      expect(done).toBe(true); expect(save).toHaveBeenCalledTimes(1)
    })

    it('keepMine on an abandoned note does nothing', async () => {
      const save = vi.fn()
      const c = new SaveController(1, save, () => {}, 800)
      c.edit(d('mine')); c.onRemote(null); await c.abandon()
      c.keepMine(); await vi.advanceTimersByTimeAsync(0)
      expect(save).not.toHaveBeenCalled()
    })
  })

  describe('hold / release (a delete is awaiting the server)', () => {
    it('stops autosave and freezes remote changes, keeps the draft, and reports the revision on screen', async () => {
      const save = vi.fn().mockResolvedValue(2)
      const c = new SaveController(1, save, () => {}, 800)
      c.edit(d('mine'))
      expect(await c.hold()).toBe(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(save).not.toHaveBeenCalled(); expect(c.draft).toEqual(d('mine'))
      expect(c.onRemote(note(2))).toBe('ignore'); expect(c.state).toBe('dirty') // not turned into a conflict, not applied
      expect(await c.settle()).toBe('dirty')                                   // leaving must not loop on a held note
    })

    it("waits for the note's own write in flight and reports its acknowledged revision", async () => {
      let resolve!: (rev: number) => void
      const save = vi.fn(() => new Promise<number>((r) => (resolve = r)))
      const c = new SaveController(1, save, () => {}, 10)
      c.edit(d('a')); await vi.advanceTimersByTimeAsync(10)
      let rev: number | null | undefined
      void c.hold().then((r) => (rev = r))
      await vi.advanceTimersByTimeAsync(0); expect(rev).toBeUndefined()
      resolve(2); await vi.advanceTimersByTimeAsync(0)
      expect(rev).toBe(2)
    })

    it('release resumes autosave of the kept draft', async () => {
      const save = vi.fn().mockResolvedValue(2)
      const c = new SaveController(1, save, () => {}, 100)
      c.edit(d('mine')); await c.hold()
      c.release(); await vi.advanceTimersByTimeAsync(100)
      expect(save).toHaveBeenCalledWith(d('mine'), 1); expect(c.state).toBe('saved')
    })

    it('after release a newer remote revision is handled again (conflict with the draft, or applied when clean)', async () => {
      const c = new SaveController(1, vi.fn(), () => {}, 800)
      c.edit(d('mine')); await c.hold(); c.release()
      expect(c.onRemote(note(2))).toBe('conflict'); expect(c.draft).toEqual(d('mine'))
      const clean = new SaveController(1, vi.fn(), () => {}, 800)
      await clean.hold(); clean.release()
      expect(clean.onRemote(note(2))).toBe('apply'); expect(clean.baseRev).toBe(2)
    })
  })
})
