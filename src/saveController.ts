import { ConflictError, type Draft, type Note } from './notesApi'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
export type RemoteResult = 'apply' | 'ignore' | 'conflict'

/**
 * Debounced autosave for one open note. "saved" is only set after the save promise resolves
 * (server ack). The local draft is kept on failure and never replaced by remote data without
 * an explicit user choice (keepMine / useRemote).
 */
export class SaveController {
  state: SaveState = 'saved'
  draft: Draft | null = null
  /** Set while state === 'conflict': the current remote note, or null if it was deleted. */
  remote: Note | null = null
  error: unknown = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private inflight: Promise<void> | undefined
  /** Set once the note is deleted on purpose: no further writes may be issued. */
  private closed = false
  /** True while a delete of this note is awaiting the server: no writes and no remote changes are applied. */
  held = false
  private disposed = false

  constructor(
    public baseRev: number | null,
    private save: (draft: Draft, baseRev: number | null) => Promise<number>,
    private notify: () => void,
    private delay = 800,
  ) {}

  private set(s: SaveState) { this.state = s; this.notify() }

  edit(d: Draft) {
    if (this.closed) return
    this.draft = d
    if (this.state === 'conflict') return // keep editing locally; resolve explicitly
    if (this.state !== 'saving') this.set('dirty')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.delay)
  }

  async flush() {
    clearTimeout(this.timer)
    if (this.closed || this.held || !this.draft || this.state === 'saving' || this.state === 'conflict') return
    const run: Promise<void> = this.write(this.draft).finally(() => {
      if (this.inflight === run) this.inflight = undefined
    })
    this.inflight = run
    await run
  }

  private async write(sent: Draft) {
    this.set('saving')
    try {
      this.baseRev = await this.save(sent, this.baseRev)
      if (this.closed) return
      if (this.draft === sent) { this.draft = null; this.set('saved') }
      else { this.set('dirty'); this.timer = setTimeout(() => void this.flush(), this.delay) }
    } catch (e) {
      if (this.closed) return
      if (e instanceof ConflictError) { this.remote = e.remote; this.set('conflict') }
      else { this.error = e; this.set('error') }
    }
  }

  /**
   * Drives pending work to a resting state before the caller leaves this note (sign-out, switching):
   * waits for a write in flight, flushes a dirty draft, follows edits made meanwhile, and retries a
   * failed draft once. Resolves with the final state; only 'saved' means nothing is left unsaved.
   * A conflict is never resolved here, it needs the user's choice.
   */
  async settle(): Promise<SaveState> {
    let retried = false
    for (;;) {
      if (this.inflight) { await this.inflight; continue }
      if (this.held) return this.state // a delete is deciding this note's fate; nothing may be written meanwhile
      if (this.draft && this.state === 'dirty') { await this.flush(); continue }
      if (this.draft && this.state === 'error' && !retried) { retried = true; await this.flush(); continue }
      return this.state
    }
  }

  /**
   * A delete of this note is about to be sent: stop autosave and freeze what the editor is based on, then
   * wait for a write of our own that is already in flight. Resolves with the revision the user is looking
   * at (own acknowledged writes included, remote changes excluded) — the revision the delete must expect.
   * The draft is kept; `release()` resumes normal operation if the delete does not happen.
   */
  async hold(): Promise<number | null> {
    clearTimeout(this.timer)
    this.held = true
    this.notify()
    await this.inflight
    return this.baseRev
  }

  /** The delete did not happen: resume autosave and remote handling; any kept draft is saved as usual. */
  release() {
    if (this.closed || this.disposed || !this.held) return
    this.held = false
    if (this.draft && this.state === 'dirty') this.timer = setTimeout(() => void this.flush(), this.delay)
    this.notify()
  }

  /**
   * The note is being deleted on purpose: drop the draft and issue no further writes. Resolves once a
   * write already in flight has finished, so the caller can order its delete after it.
   */
  async abandon(): Promise<void> {
    clearTimeout(this.timer)
    this.closed = true
    this.draft = null
    this.remote = null
    await this.inflight
  }

  /** Feed the latest snapshot of this note (null = deleted). Says whether the UI may show it. */
  onRemote(note: Note | null): RemoteResult {
    if (this.closed || this.held) return 'ignore'
    if (note && this.baseRev !== null && note.rev <= this.baseRev) return 'ignore' // our own echo
    if (this.state === 'saving') return 'ignore' // the transaction detects real conflicts
    if (this.state === 'saved' && !this.draft) {
      this.baseRev = note ? note.rev : this.baseRev
      return 'apply'
    }
    this.remote = note
    if (this.state !== 'conflict') this.set('conflict'); else this.notify()
    return 'conflict'
  }

  /** User chose to overwrite the remote version with the local draft. */
  keepMine() {
    if (this.closed || this.state !== 'conflict' || !this.draft) return
    this.baseRev = this.remote ? this.remote.rev : null
    this.remote = null
    this.state = 'dirty'
    void this.flush()
  }

  /** User chose to discard the local draft; caller shows the returned remote note. */
  useRemote(): Note | null {
    const r = this.remote
    this.draft = null
    this.remote = null
    if (r) this.baseRev = r.rev
    this.set('saved')
    return r
  }

  /** The editor is gone: nothing may be scheduled any more, even by a late release(). */
  dispose() { this.disposed = true; clearTimeout(this.timer) }
}
