# Online Notes App

A browser-based personal notes app: sign in with Google, create/edit/delete private rich-text notes that autosave to Cloud Firestore and sync across your sessions.

**Status:** Milestone 1 (secure cloud-synced notes core), developed against local emulators only. Not deployed. Search and appearance customization (Milestone 2) are not implemented. Real Google sign-in has not been tested. See `docs/PROJECT_STATE.md`.

## Setup
Requires Node 20+ and, for emulators, Java 21+ (Firestore emulator).

```
npm install
cp .env.example .env.local   # leave VITE_USE_EMULATORS=true for local work
npm run emulators            # terminal 1: Auth :9099, Firestore :8080
npm run dev                  # terminal 2
```
Emulator sign-in uses the emulator's fake Google popup (allow popups for the dev server); no Firebase project or `VITE_FIREBASE_*` values are needed, and an empty `VITE_FIREBASE_AUTH_DOMAIN` is fine in emulator mode. A live Firebase project (web config values in `.env.local` — including `VITE_FIREBASE_AUTH_DOMAIN`, usually `<project-id>.firebaseapp.com` — with the Google provider enabled and rules deployed) is needed for real use and needs owner authorization. With `VITE_USE_EMULATORS` off and no auth domain, sign-in fails with `auth/auth-domain-config-required`.

## Commands
- `npm run typecheck` / `npm run build`
- `npm test` — unit tests (autosave state machine, editor serialization)
- `npm run test:emulator` — Firestore rules + notes API/two-session sync tests (starts emulators)

## Implemented
Google sign-in/out; notes sidebar + Tiptap editor (toolbar: bold, italic, H1, H2, bullet list, checklist; **H3 has no toolbar button** — it is available only through the `Ctrl/Cmd+Alt+3` shortcut or by typing `### `; the other formats also have shortcuts, e.g. `Ctrl/Cmd+B`, `+I`, `+Alt+1`/`+Alt+2`, `+Shift+8` for a bullet list and `+Shift+9` for a checklist); autosave with Saving/Saved/Save failed states; revision-checked writes with a visible conflict-recovery UI; revision-checked deletes (a note that changed elsewhere is not deleted until you review it and confirm again) with pending/failed/unconfirmed notices; per-user Firestore rules.

## Limitations
Online-first (no offline editing or persistent cache); no search/theming; conflicts are resolved by explicit user choice, never merged; single-user notes only.
