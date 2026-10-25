import { useEffect, useRef } from 'react'
import { BACKGROUNDS, FONT_SIZES, THEMES } from './appearance'
import type { Preferences } from './usePreferences'

const STATUS: Record<Preferences['status'], string> = {
  saved: 'Saved to your account',
  saving: 'Saving…',
  error: 'Not saved — the change is only on this screen',
}

/** Appearance settings: a small non-modal panel under the header. Escape or Close returns focus to its button. */
export function Settings({ prefs, onClose }: { prefs: Preferences; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => { panel.current?.querySelector<HTMLInputElement>('input:checked')?.focus() }, [])

  const group = <K extends 'theme' | 'background' | 'fontSize'>(
    key: K, legend: string, options: readonly { id: string; label: string }[],
  ) => (
    <fieldset>
      <legend>{legend}</legend>
      <div className="options">
        {options.map((o) => (
          <label key={o.id} className={`option ${key === 'background' ? `swatch-${o.id}` : ''}`}>
            <input type="radio" name={key} value={o.id} checked={prefs.value[key] === o.id}
              onChange={() => prefs.choose(key, o.id as never)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )

  return (
    <section ref={panel} className="settings" id="settings" role="dialog" aria-label="Appearance settings"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="settings-head">
        <strong>Appearance</strong>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {group('theme', 'Theme', THEMES)}
      {group('background', 'Background', BACKGROUNDS)}
      {group('fontSize', 'Note text size', FONT_SIZES)}
      <p className={`prefs-status ${prefs.status}`} role="status">
        {STATUS[prefs.status]}
        {prefs.status === 'error' && <button type="button" onClick={prefs.retry}>Retry</button>}
      </p>
      {prefs.problem && <p className="err" role="alert">{prefs.problem}</p>}
    </section>
  )
}
