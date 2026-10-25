# Online Notes App

A browser-based personal notes app: sign in with Google, create/edit/delete private rich-text notes that autosave to Cloud Firestore and sync across your sessions.

**Status:** Milestones 1, 2 and 3 are published in this public GitHub repository, and Milestone 3 is integrated into `main`. Milestone 3 adds note search, appearance customization (theme, background and text size, synchronized per user) and reliability improvements. Everything was developed and verified against local emulators only: the app is not deployed, and real Google sign-in has not been tested. Public source availability does not mean a production application is running. See `docs/PROJECT_STATE.md`.

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
- `npm test` — unit and UI tests (autosave state machine, editor serialization, search, preferences controller, App/Editor behavior in jsdom)
- `npm run test:emulator` — Firestore rules (notes and preferences), notes API, preference persistence/sync/isolation and deletion-boundary tests against the Auth and Firestore emulators (starts them; needs Java 21+)

## Implemented
Google sign-in/out; notes sidebar + Tiptap editor (toolbar: bold, italic, H1, H2, bullet list, checklist; **H3 has no toolbar button** — it is available only through the `Ctrl/Cmd+Alt+3` shortcut or by typing `### `; the other formats also have shortcuts, e.g. `Ctrl/Cmd+B`, `+I`, `+Alt+1`/`+Alt+2`, `+Shift+8` for a bullet list and `+Shift+9` for a checklist); autosave with Saving/Saved/Save failed states; revision-checked writes with a visible conflict-recovery UI; revision-checked deletes (a note that changed elsewhere is not deleted until you review it and confirm again) with pending/failed/unconfirmed notices; search; appearance settings; per-user Firestore rules.

### Search
Type in the **Search notes** box above the list. A note matches when every word you typed appears (any case) in its title or in its text — headings, paragraphs, list and checklist items. Formatting itself is never searched. The list narrows as you type and follows changes as they sync; clearing the box restores the full list. "No notes match" (with a Clear search button) is different from "No notes yet". Searching never changes a note, and the note you have open stays open, with your unsaved edits, even when it is not in the results. Search covers saved content: an open note's unsaved edits are not searched until they are saved.

### Appearance settings
**Settings** in the header opens a panel with: theme (light or dark), background (plain, paper, mint, sky, rose) and note text size (small, medium, large, extra large). Changes show immediately and are saved to your account, so they follow you to every session and survive a reload; the panel says "Saving…" until the server confirms and "Not saved" (with Retry) if it cannot. Another session of the same account updates live. Each account has its own settings; with no saved settings the light, plain, medium defaults apply. Everything is operable with the keyboard (Escape closes the panel).

## Limitations
Online-first (no offline editing or persistent cache); conflicts are resolved by explicit user choice, never merged; single-user notes only.

- The expected-revision delete check runs in the application's client transaction. A modified Firestore SDK client signed in as the same owner can bypass it (verified with the emulator); Firestore rules still enforce ownership. Stronger enforcement would need an owner decision (see `docs/DECISIONS.md`).
- An unconfirmed deletion stays flagged (banner and ⚠ in the list) until the server shows the note gone or you delete again; the flag lives in memory for the session only.
- While a delete of the open note is pending and the note has unsaved edits, switching notes waits until the server answers, so those edits are not lost if the delete is refused.
- Drafts are not stored on your device: closing the tab or signing out elsewhere with unsaved edits loses them.
- Concurrent changes to the same appearance setting from two sessions end with the later one.
