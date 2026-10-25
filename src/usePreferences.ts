import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { applyAppearance, type Appearance } from './appearance'
import { PreferencesController, type PrefsStatus } from './preferencesController'
import { savePreferences, subscribePreferences } from './preferencesApi'
import { db } from './firebase'

export interface Preferences {
  value: Appearance
  status: PrefsStatus
  /** Why the last save failed, or why the stored preferences could not be loaded. */
  problem: string
  choose: <K extends keyof Appearance>(key: K, value: Appearance[K]) => void
  retry: () => void
}

/**
 * The signed-in user's appearance preferences: loaded and kept in sync from Firestore, applied to the page
 * root while mounted, and removed again on unmount so the next user (or the signed-out screen) starts clean.
 * Mount it under a component keyed by uid.
 */
export function usePreferences(uid: string): Preferences {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const ctl = useRef<PreferencesController>(null as unknown as PreferencesController)
  if (!ctl.current) ctl.current = new PreferencesController((patch) => savePreferences(db, uid, patch), rerender)
  const c = ctl.current
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    c.activate()
    const stop = subscribePreferences(db, uid,
      (a) => { setLoadError(''); c.onRemote(a) },
      (e) => { setLoadError(e.message); c.onLoadError() })
    const reconnect = () => c.retry()
    window.addEventListener('online', reconnect)
    return () => { stop(); window.removeEventListener('online', reconnect); c.dispose() }
  }, [uid])

  const v = c.value
  useLayoutEffect(() => {
    applyAppearance(document.documentElement, v)
  }, [v.theme, v.background, v.fontSize])
  useLayoutEffect(() => () => applyAppearance(document.documentElement, null), [])

  const problem = c.status === 'error'
    ? `Could not save your appearance settings: ${String((c.error as Error)?.message ?? c.error)}`
    : loadError ? `Could not load your appearance settings (defaults are shown): ${loadError}` : ''
  return { value: v, status: c.status, problem, choose: (k, val) => c.choose(k, val), retry: () => c.retry() }
}
