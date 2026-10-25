import { describe, expect, it, vi } from 'vitest'
import { PreferencesController } from '../src/preferencesController'
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance } from '../src/appearance'

const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const settle = () => new Promise((r) => setTimeout(r, 0))
const make = (save: (p: Partial<Appearance>) => Promise<void> = async () => {}) => {
  const notify = vi.fn()
  return { c: new PreferencesController(save, notify), notify }
}

describe('parseAppearance', () => {
  it('uses the defaults for a missing document', () => expect(parseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE))
  it('keeps valid values and falls back per field for unknown or wrongly typed ones', () => {
    expect(parseAppearance({ theme: 'dark', background: 'hotpink', fontSize: 12, extra: 1 }))
      .toEqual({ theme: 'dark', background: DEFAULT_APPEARANCE.background, fontSize: DEFAULT_APPEARANCE.fontSize })
  })
})

describe('PreferencesController', () => {
  it('starts on the defaults, saved, not yet loaded', () => {
    const { c } = make()
    expect(c.value).toEqual(DEFAULT_APPEARANCE); expect(c.status).toBe('saved'); expect(c.loaded).toBe(false)
  })

  it('shows stored preferences once they arrive', () => {
    const { c } = make()
    c.onRemote({ theme: 'dark', background: 'mint', fontSize: 'large' })
    expect(c.value).toEqual({ theme: 'dark', background: 'mint', fontSize: 'large' }); expect(c.loaded).toBe(true)
  })

  it('a choice shows at once but is "saving" - not saved - until the server acknowledges it', async () => {
    const w = deferred(); const save = vi.fn(() => w.promise)
    const { c } = make(save)
    c.choose('theme', 'dark')
    expect(c.value.theme).toBe('dark'); expect(c.status).toBe('saving')
    expect(save).toHaveBeenCalledWith({ theme: 'dark' })
    await settle(); expect(c.status).toBe('saving')       // still no ack
    w.resolve(); await settle()
    expect(c.status).toBe('saved'); expect(c.value.theme).toBe('dark')
  })

  it('theme, background and font size are each written as their own change', async () => {
    const save = vi.fn(async () => {})
    const { c } = make(save)
    c.choose('theme', 'dark'); await settle()
    c.choose('background', 'sky'); await settle()
    c.choose('fontSize', 'xlarge'); await settle()
    expect(save.mock.calls).toEqual([[{ theme: 'dark' }], [{ background: 'sky' }], [{ fontSize: 'xlarge' }]])
    expect(c.value).toEqual({ theme: 'dark', background: 'sky', fontSize: 'xlarge' })
  })

  it('a failed save is reported as an error, keeps the choice on screen, and Retry saves it', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const { c } = make(save)
    c.choose('fontSize', 'large'); await settle()
    expect(c.status).toBe('error'); expect(String((c.error as Error).message)).toBe('offline'); expect(c.value.fontSize).toBe('large')
    c.retry(); expect(c.status).toBe('saving'); await settle()
    expect(save).toHaveBeenCalledTimes(2); expect(save).toHaveBeenLastCalledWith({ fontSize: 'large' })
    expect(c.status).toBe('saved')
  })

  it('retry does nothing when nothing failed', async () => {
    const save = vi.fn(async () => {}); const { c } = make(save)
    c.retry(); await settle(); expect(save).not.toHaveBeenCalled(); expect(c.status).toBe('saved')
  })

  it('a remote change never replaces a field with an unsaved local choice', async () => {
    const w = deferred(); const { c } = make(() => w.promise)
    c.onRemote(DEFAULT_APPEARANCE)
    c.choose('theme', 'dark')
    c.onRemote({ theme: 'light', background: 'rose', fontSize: 'small' })   // another session changed everything
    expect(c.value).toEqual({ theme: 'dark', background: 'rose', fontSize: 'small' })   // theme is ours, the rest is theirs
    w.resolve(); await settle()
    expect(c.value.theme).toBe('dark')
  })

  it('also keeps an unsaved choice that failed to save when remote data arrives', async () => {
    const { c } = make(async () => { throw new Error('offline') })
    c.choose('theme', 'dark'); await settle()
    c.onRemote({ theme: 'light', background: 'plain', fontSize: 'medium' })
    expect(c.value.theme).toBe('dark'); expect(c.status).toBe('error')
  })

  it('changes made while a write is in flight are written next and stay unsaved until then', async () => {
    const first = deferred(); const second = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { c } = make(save)
    c.choose('theme', 'dark')
    c.choose('theme', 'light'); c.choose('background', 'mint')
    expect(save).toHaveBeenCalledTimes(1)
    first.resolve(); await settle()
    expect(c.status).toBe('saving')                                     // the later choices are not acknowledged yet
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', background: 'mint' })
    expect(c.value).toEqual({ theme: 'light', background: 'mint', fontSize: 'medium' })
    second.resolve(); await settle()
    expect(c.status).toBe('saved')
  })

  it('concurrent changes to different fields from two sessions both survive (server merges per field)', async () => {
    // the API writes only the changed fields on top of the stored document; the controller sends only those
    const stored = { ...DEFAULT_APPEARANCE }
    const apply = (p: Partial<Appearance>) => Object.assign(stored, p)
    const a = make(async (p) => { apply(p) }).c, b = make(async (p) => { apply(p) }).c
    a.choose('theme', 'dark'); b.choose('fontSize', 'large'); await settle()
    expect(stored).toEqual({ theme: 'dark', background: 'plain', fontSize: 'large' })
  })

  it('late results after dispose change nothing and notify nobody', async () => {
    const w = deferred(); const { c, notify } = make(() => w.promise)
    c.choose('theme', 'dark'); c.dispose(); notify.mockClear()
    w.resolve(); await settle()
    expect(notify).not.toHaveBeenCalled()
    c.onRemote(DEFAULT_APPEARANCE); expect(notify).not.toHaveBeenCalled()
  })

  it('a load error leaves the defaults in effect and counts as loaded', () => {
    const { c } = make(); c.onLoadError()
    expect(c.value).toEqual(DEFAULT_APPEARANCE); expect(c.loaded).toBe(true)
  })

  it('after activate() a re-mounted controller accepts results again', async () => {
    const { c, notify } = make(); c.dispose(); c.activate(); notify.mockClear()
    c.onRemote({ ...DEFAULT_APPEARANCE, theme: 'dark' }); expect(notify).toHaveBeenCalled()
  })
})
