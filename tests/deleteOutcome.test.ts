import { describe, expect, it, vi } from 'vitest'

// Classification of "did the server decide?" for deleteNote. The transaction itself (atomicity, revision
// checks) is exercised against the emulator elsewhere; here runTransaction is replaced by a loop that
// behaves like the SDK's — it re-runs the callback when an attempt fails with a retryable error — and each
// attempt's outcome is scripted, so failures can be injected at a chosen stage of a chosen attempt.
type Step = {
  read?: { code: string } | { rev: number }   // default: the note exists at rev 3
  commit?: { code: string }                   // default: the commit succeeds
}
let script: Step[] = []
const RETRYABLE = new Set(['aborted', 'unavailable', 'deadline-exceeded', 'unknown', 'internal', 'cancelled'])
vi.mock('firebase/firestore', async (orig) => ({
  ...(await orig<typeof import('firebase/firestore')>()),
  doc: () => ({ id: 'n1' }),
  collection: () => ({}),
  runTransaction: async (_db: unknown, cb: (tx: any) => Promise<unknown>) => {
    let last: unknown
    for (const step of script) {
      const tx = {
        get: async () => {
          if (step.read && 'code' in step.read) throw Object.assign(new Error('read failed'), step.read)
          const rev = step.read && 'rev' in step.read ? step.read.rev : 3
          return { exists: () => true, data: () => ({ rev, title: 't', content: '{}', updatedAt: null }) }
        },
        delete: () => {},
      }
      try {
        const result = await cb(tx)
        if (step.commit) throw Object.assign(new Error('commit failed'), step.commit)
        return result
      } catch (e) {
        last = e
        const code = (e as { code?: string }).code
        if (!code || !RETRYABLE.has(code)) throw e // e.g. the callback's own ConflictError, or a refusal
      }
    }
    throw last
  },
}))

import { ConflictError, DeleteOutcomeUnknownError, deleteNote } from '../src/notesApi'
const call = (rev: number | null = 3) => deleteNote({} as any, 'u', 'n1', rev)
const run = async (steps: Step[], rev: number | null = 3) => { script = steps; return call(rev).then(() => null, (e) => e) }

describe('deleteNote outcome classification', () => {
  it('resolves deleted when the server accepts it', async () => {
    script = [{}]
    await expect(call()).resolves.toBe('deleted')
  })

  it('a connection failure after the delete was sent is an unknown outcome — not a failure, not a success', async () => {
    for (const code of ['unavailable', 'deadline-exceeded', 'unknown', 'internal', 'cancelled']) {
      expect(await run([{ commit: { code } }]), code).toBeInstanceOf(DeleteOutcomeUnknownError)
    }
  })

  it('a refusal by the server is a plain failure: it was not deleted', async () => {
    for (const code of ['permission-denied', 'unauthenticated', 'failed-precondition']) {
      const err = await run([{ commit: { code } }])
      expect(err, code).not.toBeInstanceOf(DeleteOutcomeUnknownError); expect(err.code).toBe(code)
    }
  })

  it('a failure before anything was sent (offline while reading, on every attempt) is a plain failure', async () => {
    const err = await run([{ read: { code: 'unavailable' } }, { read: { code: 'unavailable' } }])
    expect(err).not.toBeInstanceOf(DeleteOutcomeUnknownError); expect(err.code).toBe('unavailable')
  })

  it('a revision mismatch is a conflict carrying the current note, and nothing is sent', async () => {
    const err = await run([{}], 2)
    expect(err).toBeInstanceOf(ConflictError); expect(err.remote).toMatchObject({ id: 'n1', rev: 3 })
  })

  describe('retries (the SDK re-runs the transaction on connection errors)', () => {
    it('an earlier attempt that reached the server makes a later read failure unknown too', async () => {
      // attempt 1: delete sent, answer lost · attempt 2: cannot even read — attempt 1 may have been applied
      const err = await run([{ commit: { code: 'unavailable' } }, { read: { code: 'unavailable' } }])
      expect(err).toBeInstanceOf(DeleteOutcomeUnknownError)
    })

    it('a conflict seen on a retry stays a conflict, although an earlier attempt had been sent and aborted', async () => {
      const err = await run([{ commit: { code: 'aborted' } }, { read: { rev: 4 } }])
      expect(err).toBeInstanceOf(ConflictError); expect(err.remote.rev).toBe(4)
    })

    it('a retry that succeeds is a success', async () => {
      script = [{ commit: { code: 'aborted' } }, {}]
      await expect(call()).resolves.toBe('deleted')
    })
  })
})
