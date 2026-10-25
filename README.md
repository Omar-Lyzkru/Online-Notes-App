# Online Notes App

A browser-based personal notes app: sign in with Google, create/edit/delete private rich-text notes that autosave to Cloud Firestore and sync across your sessions.

**Status:** Milestone 1 (secure cloud-synced notes core) is implemented and integrated locally, developed against local emulators only. Milestone 2 source is published in the public [GitHub repository](https://github.com/Omar-Lyzkru/Online-Notes-App), with `main` as its default branch. Public source availability does not mean a production application is running. The app is not deployed, and real Google sign-in has not been tested. Search and appearance customization are not implemented. See `docs/PROJECT_STATE.md`.

## Setup
Requires Node 22.22.2 or later within 22.x, or Node 24.15.0 or later within 24.x, to satisfy the locked development and test dependencies. Emulators also require Java 21+ (Firestore emulator).

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

- The expected-revision delete check runs in the application's client transaction. A modified Firestore SDK client signed in as the same owner can bypass it; Firestore rules still enforce ownership.
- Dismissing an unconfirmed deletion notice forgets the displayed uncertainty; dismissal does not confirm the outcome.
- If you edit a note while its deletion is pending and then accept the prompt to switch notes, those unsaved edits are not saved, even if the deletion is later refused.
