import { DEFAULT_APPEARANCE, type Appearance } from './appearance'

/** saved: the server holds what is shown · saving: a change is on its way · error: a change was not saved */
export type PrefsStatus = 'saved' | 'saving' | 'error'

/**
 * The user's appearance choices for one signed-in session.
 *
 * What is shown is the last known server state with the user's unsaved choices on top. A choice stays
 * "unsaved" until the server acknowledged a write containing it: only then does the status go back to
 * 'saved'. A failed write keeps the choice (shown, marked 'error') for a retry. Remote changes never
 * replace a field with an unsaved local choice; they apply to every other field at once.
 */
export class PreferencesController {
  status: PrefsStatus = 'saved'
  error: unknown = null
  /** True once the first server/cache snapshot arrived (until then the defaults are shown). */
  loaded = false
  private server: Appearance = DEFAULT_APPEARANCE
  private dirty: Partial<Appearance> = {}
  private inflight = false
  private active = true

  constructor(
    private save: (patch: Partial<Appearance>) => Promise<void>,
    private notify: () => void,
  ) {}

  get value(): Appearance { return { ...this.server, ...this.dirty } }

  /** The component is (re)mounted: late results are accepted again. */
  activate() { this.active = true }
  /** The component is gone (sign-out, uid change): late results are ignored, nothing more is written. */
  dispose() { this.active = false }

  private update() { if (this.active) this.notify() }

  /** The user picked a value. It is shown immediately and written; the status says whether it is saved. */
  choose<K extends keyof Appearance>(key: K, value: Appearance[K]) {
    this.dirty = { ...this.dirty, [key]: value }
    this.status = 'saving'
    this.update()
    void this.flush()
  }

  /** The stored preferences changed (maybe in another session). Unsaved local choices are kept. */
  onRemote(a: Appearance) {
    this.server = a
    this.loaded = true
    this.update()
  }

  /** The preferences could not be loaded; the defaults stay in effect. */
  onLoadError() { this.loaded = true; this.update() }

  /** Tries again after a failure (or after reconnecting). */
  retry() { if (this.status === 'error') { this.status = 'saving'; this.update(); void this.flush() } }

  private async flush() {
    if (this.inflight || !this.active) return
    this.inflight = true
    try {
      for (;;) {
        const sent = this.dirty
        if (Object.keys(sent).length === 0) break
        try {
          await this.save(sent)
        } catch (e) {
          this.error = e
          this.status = 'error'
          return
        }
        // Acknowledged. Keep a field unsaved if the user changed it again while the write was in flight.
        const rest: Partial<Appearance> = {}
        for (const k of Object.keys(this.dirty) as (keyof Appearance)[]) {
          if (this.dirty[k] !== sent[k]) (rest as Record<string, unknown>)[k] = this.dirty[k]
        }
        // What the server now holds includes what was sent, whether or not its snapshot has arrived yet.
        this.server = { ...this.server, ...sent }
        this.dirty = rest
        this.status = Object.keys(rest).length ? 'saving' : 'saved'
        this.update()
      }
    } finally {
      this.inflight = false
      this.update()
    }
  }
}
