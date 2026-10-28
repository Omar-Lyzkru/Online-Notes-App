import type { FirebaseOptions } from 'firebase/app'

/** The variables this module reads (Vite's `import.meta.env`, or a plain object in tests and in `vite.config.ts`). */
export type ConfigEnv = Record<string, unknown>

/** Every reason the configuration cannot be used, in words a person can act on. */
export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid Firebase configuration:\n${problems.map((p) => `- ${p}`).join('\n')}`)
  }
}

export type FirebaseSetup = { kind: 'emulator' } | { kind: 'live'; options: FirebaseOptions }

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Decides which Firebase backend this build talks to, or throws a ConfigError. There is no silent fallback:
 *  - A production build (`production`) always talks to a live project, and its configuration must be
 *    complete and consistent. `VITE_USE_EMULATORS` must not be set to anything but `false` there.
 *  - The dev server uses the local emulators unless `VITE_USE_EMULATORS=false`, in which case it needs the
 *    same live configuration.
 * Web-client values (API key, app id) identify the project, they are not secrets; service-account keys,
 * admin tokens and private keys have no place in any `VITE_*` variable (they would be shipped to browsers).
 */
export function resolveFirebaseSetup(env: ConfigEnv, production: boolean): FirebaseSetup {
  const problems: string[] = []
  const flag = text(env.VITE_USE_EMULATORS)
  if (!['', 'true', 'false'].includes(flag)) problems.push(`VITE_USE_EMULATORS must be "true", "false" or empty, not "${flag}".`)
  if (production && flag === 'true') {
    problems.push('VITE_USE_EMULATORS=true is not allowed in a production build (a stray .env.local would otherwise ship emulator endpoints). Remove it from .env, .env.local and .env.production*.')
  }
  if (problems.length === 0 && !production && flag !== 'false') return { kind: 'emulator' }

  const apiKey = text(env.VITE_FIREBASE_API_KEY), authDomain = text(env.VITE_FIREBASE_AUTH_DOMAIN)
  const projectId = text(env.VITE_FIREBASE_PROJECT_ID), appId = text(env.VITE_FIREBASE_APP_ID)
  for (const [name, v] of [['VITE_FIREBASE_API_KEY', apiKey], ['VITE_FIREBASE_AUTH_DOMAIN', authDomain],
    ['VITE_FIREBASE_PROJECT_ID', projectId], ['VITE_FIREBASE_APP_ID', appId]] as const) {
    if (!v) problems.push(`${name} is missing.`)
  }
  if (apiKey === 'demo-key') problems.push('VITE_FIREBASE_API_KEY is the emulator placeholder.')
  if (projectId) {
    if (projectId.startsWith('demo-')) problems.push(`VITE_FIREBASE_PROJECT_ID "${projectId}" is an emulator-only demo project.`)
    else if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) problems.push(`VITE_FIREBASE_PROJECT_ID "${projectId}" is not a valid Firebase project ID.`)
    else if (authDomain && authDomain !== `${projectId}.firebaseapp.com` && authDomain !== `${projectId}.web.app`) {
      problems.push(`VITE_FIREBASE_AUTH_DOMAIN "${authDomain}" does not belong to project "${projectId}" (expected ${projectId}.firebaseapp.com or ${projectId}.web.app).`)
    }
  }
  if (appId && !/^1:\d+:web:[0-9a-f]+$/.test(appId)) problems.push('VITE_FIREBASE_APP_ID is not a web app id (expected 1:<number>:web:<hex>).')
  if (problems.length) throw new ConfigError(problems)
  return { kind: 'live', options: { apiKey, authDomain, projectId, appId } }
}

/** The live options of a setup that must be live (a ConfigError otherwise: there is no fallback to anything else). */
export function liveOptions(setup: FirebaseSetup): FirebaseOptions {
  if (setup.kind !== 'live') throw new ConfigError(['A live Firebase configuration is required here.'])
  return setup.options
}
