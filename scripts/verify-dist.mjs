#!/usr/bin/env node
// Inspects a production build (dist/) before it is deployed. Offline, read-only.
//   node scripts/verify-dist.mjs --project <firebase-project-id> [--dir dist]
// Fails (exit 1) when the bundle: points at a different project than the one about to be deployed, contains
// emulator or development endpoints, contains anything shaped like a credential, or ships files it should not.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const dir = opt('--dir') ?? 'dist'
const project = opt('--project') ?? process.env.FIREBASE_PROJECT_ID
const fail = []

if (!project || /^demo-/.test(project) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
  console.error('Pass the intended Firebase project id explicitly: --project <id> (not a demo-* project).')
  process.exit(2)
}

const files = []
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
try { walk(dir) } catch { console.error(`No build output at ${dir}/. Run the production build first.`); process.exit(2) }

for (const f of files) {
  const rel = relative(dir, f)
  if (/(^|\/)\.env|\.map$|firebase\.json$|\.rules$|adminsdk|service-account|\.pem$|(^|\/)\.firebaserc$/i.test(rel)) fail.push(`unexpected file in the build output: ${rel}`)
}
const text = files.filter((f) => /\.(js|mjs|css|html|json|txt|webmanifest)$/.test(f)).map((f) => [relative(dir, f), readFileSync(f, 'utf8')])
const all = text.map(([, t]) => t).join('\n')

// Emulator / development endpoints and placeholders (what a stray VITE_USE_EMULATORS or demo config would leave behind).
// (Quotes: the minifier emits backticks. `demo-key` alone is not flagged: the config validator names it to reject it.)
const forbidden = [
  [/localhost:(9099|8080|9150|4000|5001)/, 'emulator endpoint'], [/127\.0\.0\.1:\d+/, 'loopback endpoint'],
  [/["'`]localhost["'`]\s*,\s*8080/, 'Firestore emulator host/port'],
  [/apiKey:\s*["'`]demo-key/, 'emulator placeholder API key in the Firebase options'],
  [/projectId:\s*["'`]demo-/, 'emulator demo project id in the Firebase options'],
  [/authDomain:\s*["'`]localhost/, 'emulator auth domain in the Firebase options'],
  [/emulator\.googleapis|__\/auth\/emulator/, 'emulator URL'],
]
for (const [re, what] of forbidden) {
  const hit = text.find(([, t]) => re.test(t))
  if (hit) fail.push(`${what} found in ${hit[0]} (${re})`)
}
// Credentials. Web API keys (AIza...) are public identifiers and expected; private material is not.
for (const [re, what] of [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'], [/"private_key"\s*:/, 'service-account private_key field'],
  [/"type"\s*:\s*"service_account"/, 'service-account JSON'], [/[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/, 'service-account address'],
  [/ya29\.[0-9A-Za-z_-]{20,}/, 'Google OAuth access token'], [/1\/\/[0-9A-Za-z_-]{40,}/, 'Google OAuth refresh token'],
  [/GOCSPX-[0-9A-Za-z_-]{10,}/, 'OAuth client secret'], [/AAAA[0-9A-Za-z_-]{7}:[0-9A-Za-z_-]{140,}/, 'FCM server key'],
]) { if (re.test(all)) fail.push(`${what} found in the build output (${re})`) }

// The bundle must name the project being deployed, and no other firebase project domain.
const hasProject = new RegExp(`projectId:\\s*["']${project}["']`).test(all) || all.includes(`"${project}"`) || all.includes(`'${project}'`) || all.includes(`\`${project}\``)
if (!hasProject) fail.push(`the build does not contain project id "${project}"; it was built for a different project or configuration`)
const others = new Set([...all.matchAll(/\b([a-z][a-z0-9-]{4,28}[a-z0-9])\.(firebaseapp\.com|web\.app)\b/g)].map((m) => m[1]).filter((p) => p !== project))
if (others.size) fail.push(`the build refers to other Firebase project domains: ${[...others].join(', ')}`)

if (fail.length) {
  console.error(`verify-dist: ${fail.length} problem(s) in ${dir}/ for project "${project}":\n${fail.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`verify-dist: ok — ${files.length} files in ${dir}/, built for project "${project}", no emulator endpoints, no credential patterns.`)
