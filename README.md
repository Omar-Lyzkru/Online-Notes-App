# Online Notes App

A browser-based personal notes app: sign in with Google, create/edit/delete private rich-text notes that autosave to Cloud Firestore and sync across your sessions.

**Status:** Milestones 1–4 are integrated into `main` and published in this public GitHub repository. Milestone 4 (production readiness and deployment preparation) was independently reviewed and integrated (implementation commit `f233058`; published integration commit `2503ca4`). It added personal-only Firebase UID authorization, Hosting configuration, production-build safeguards and deployment/recovery procedures. The production Firebase configuration (Gate 2) and the first Firebase Hosting release (Gate 3) are complete as accepted by independent review, **with documented verification limitations** (see Limitations). The application is live at **https://omar-online-notes-prod.web.app** (also `https://omar-online-notes-prod.firebaseapp.com`) as a **personal-only** app: any Google account can authenticate, but only the owner's allowlisted UID can read or write data, and Firestore Security Rules are the security boundary. The deployed build was made from source commit `4e69632fe071e4b0d9f590e27e500c141ff584bd` (Hosting release `1793328233936000`, version `75174114afd62241`); later documentation-only commits do not redeploy it. Google sign-in on the hosted origin was exercised in the accepted hosted test (owner-reported). Formal Milestone 4 closure is a separate decision for the project owner and is not asserted here. See `docs/PROJECT_STATE.md` and `docs/DEPLOYMENT.md`.

## Access model (personal-only)
The app is for one owner. Anyone can authenticate with Google, but **Firestore Security Rules** let a signed-in user touch data only if (1) their own uid is on the allowlist — a document `authorizedUsers/{uid}` with `active: true`, which no client can read or write and which only privileged access (the Firebase console or Admin credentials) can create — **and** (2) the path is under their own uid. A user who is not allowlisted sees an "Access denied" screen with a Sign out button; that screen is only an explanation, the rules are the enforcement (a modified client gets the same refusal). The allowlist is empty until the owner provisions their uid, so a fresh deployment denies everyone. No uid or email is committed to this repository. Details: `docs/ARCHITECTURE.md`, procedure: `docs/DEPLOYMENT.md`.

## Setup (local development, emulators)
Requires Node 22.22.2 or later within 22.x, or Node 24.15.0 or later within 24.x, to satisfy the locked development and test dependencies. Emulators also require Java 21+ (Firestore emulator).

```
npm install
npm run emulators            # terminal 1: Auth :9099, Firestore :8080
npm run dev                  # terminal 2
```
`npm run dev` uses the local emulators by default; no env file, Firebase project or `VITE_FIREBASE_*` values are needed. Emulator sign-in uses the emulator's fake Google popup (allow popups for the dev server). **A fresh emulator has an empty allowlist, so the first account you sign in with sees "Access denied"**: add its uid to the emulator allowlist (the uid is shown in the Auth emulator's user list, `curl -X POST -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' -d '{}' http://localhost:9099/identitytoolkit.googleapis.com/v1/projects/demo-notes/accounts:query`; then `curl -X PATCH -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' -d '{"fields":{"active":{"booleanValue":true}}}' "http://localhost:8080/v1/projects/demo-notes/databases/(default)/documents/authorizedUsers/<uid>"`) and reload. The bearer token `owner` is the emulator's privileged access; it works only against emulators. Emulator data is lost when the emulators stop.

### Environment separation
| Context | Backend | Configuration |
|---|---|---|
| `npm run dev` | emulators (default) | none; `VITE_USE_EMULATORS=false` plus the live web config in `.env.development.local` points the dev server at a live project instead |
| `npm test` | none (fakes) | none |
| `npm run test:emulator` | emulators, project `demo-notes` | none |
| `npm run build` | a live project, **never** the emulators | all four `VITE_FIREBASE_*` values, from `.env.production.local` (template: `.env.production.example`) or the environment |

`npm run build` fails, naming every problem, when a value is missing, the auth domain does not belong to the project, the project is a `demo-*` one, `VITE_USE_EMULATORS=true` is set anywhere (including a stray `.env.local`), or `NODE_ENV` is not `production`. The emulator code is removed from production bundles. Run `npm run verify:dist -- --project <project-id>` on the build before deploying. Web config values identify a project and are not secrets, but **never put service-account keys, admin tokens or private keys in any `VITE_*` variable or in the repository**: `VITE_*` values are shipped to every browser. Local env files (`.env*` except the `*.example` templates) and `.firebaserc` are ignored by Git.

## Commands
- `npm run typecheck`
- `npm run build` — production build; needs the production configuration above (fails without it, by design)
- `npm run verify:dist -- --project <id>` — inspects `dist/` before deployment: the project it was built for, emulator endpoints, credential patterns, stray files
- `npm test` — unit and UI tests (autosave state machine, editor serialization, search, preferences controller, App/Editor behavior and the access-denied screen in jsdom, Firebase configuration rules, production build and `verify-dist` checks)
- `npm run test:emulator` — Firestore rules (notes, preferences, the UID allowlist and its protection, the lockdown ruleset), notes API, preference persistence/sync/isolation and deletion-boundary tests against the Auth and Firestore emulators (starts them; needs Java 21+)

## Implemented
Google sign-in/out; personal-only access (UID allowlist, access-denied screen); notes sidebar + Tiptap editor (toolbar: bold, italic, H1, H2, bullet list, checklist; **H3 has no toolbar button** — it is available only through the `Ctrl/Cmd+Alt+3` shortcut or by typing `### `; the other formats also have shortcuts, e.g. `Ctrl/Cmd+B`, `+I`, `+Alt+1`/`+Alt+2`, `+Shift+8` for a bullet list and `+Shift+9` for a checklist); autosave with Saving/Saved/Save failed states; revision-checked writes with a visible conflict-recovery UI; revision-checked deletes (a note that changed elsewhere is not deleted until you review it and confirm again) with pending/failed/unconfirmed notices; search; appearance settings; per-user Firestore rules.

### Search
Type in the **Search notes** box above the list. A note matches when every word you typed appears (any case) in its title or in its text — headings, paragraphs, list and checklist items. Formatting itself is never searched. The list narrows as you type and follows changes as they sync; clearing the box restores the full list. "No notes match" (with a Clear search button) is different from "No notes yet". Searching never changes a note, and the note you have open stays open, with your unsaved edits, even when it is not in the results. Search covers saved content: an open note's unsaved edits are not searched until they are saved.

### Appearance settings
**Settings** in the header opens a panel with: theme (light or dark), background (plain, paper, mint, sky, rose) and note text size (small, medium, large, extra large). Changes show immediately and are saved to your account, so they follow you to every session and survive a reload; the panel says "Saving…" until the server confirms and "Not saved" (with Retry) if it cannot. Another session of the same account updates live. Each account has its own settings; with no saved settings the light, plain, medium defaults apply. Everything is operable with the keyboard (Escape closes the panel).

## Deployment
Deployed to Firebase Hosting project `omar-online-notes-prod` (default site, standard URL `https://omar-online-notes-prod.web.app`; there is no custom domain). The first release was built from commit `4e69632fe071e4b0d9f590e27e500c141ff584bd`. The runbook in `docs/DEPLOYMENT.md` keeps the completed initial setup (project, Google provider, rules, allowlist provisioning) for recovery or a new environment, the reusable Hosting release procedure, verification lists and rollback. Future releases follow that runbook and remain gated: changing a live Firebase project, deploying rules, deploying Hosting, billing changes and any real-data operation each need separate, explicit owner authorization.

## Limitations
Online-first (no offline editing or persistent cache); conflicts are resolved by explicit user choice, never merged; single-user notes only.

- Access control is enforced by Firestore rules only; the Access-denied screen does not and cannot prevent a modified client from trying. Revoking an allowlist entry stops new server access (denied in the scenarios tested), but notes already downloaded in an open session may stay visible in that browser until it reloads; this is accepted current behavior, not a redesign request.
- **Hosted verification limits.** Synchronization between two browser sessions of one account worked; synchronization between two distinct physical computers (laptop and desktop) was **not verified**. The accepted hosted flow was tested in Chrome; other browsers, extensions and privacy configurations were not, so the absence of a Firebase Auth iframe/header problem (VG-1) in the tested flow does not establish it for every configuration. The owner reported once that bold and italic did not work; later hosted and automated checks passed, the failure was **not reproduced**, and no root cause or fix is claimed. A brief "Not connected to the server" message was observed during a deletion while no request failure was established; it was not changed.
- No backup or export is configured (managed exports need billing, which is not enabled), so no recovery point for notes exists. A Hosting rollback never restores Firestore data.

- The expected-revision delete check runs in the application's client transaction. A modified Firestore SDK client signed in as the same owner can bypass it (verified with the emulator); Firestore rules still enforce ownership. Stronger enforcement would need an owner decision (see `docs/DECISIONS.md`).
- An unconfirmed deletion stays flagged (banner and ⚠ in the list) until the server shows the note gone or you delete again; the flag lives in memory for the session only.
- While a delete of the open note is pending and the note has unsaved edits, switching notes waits until the server answers, so those edits are not lost if the delete is refused.
- Drafts are not stored on your device: closing the tab or signing out elsewhere with unsaved edits loses them.
- Concurrent changes to the same appearance setting from two sessions end with the later one.
