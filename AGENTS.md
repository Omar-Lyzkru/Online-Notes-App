# Agent guidance

**Stack (approved):** React + TypeScript + Vite, Firebase Auth (Google), Cloud Firestore, Firebase Hosting, Tiptap, plain CSS variables. No custom backend, no extra state framework.
**Out of scope:** AI, sharing/collaboration, folders, attachments, offline editing/persistent cache, advanced editor nodes.

## Commands
`npm run typecheck`, `npm run build` (production; needs the production config, fails without it by design), `npm run verify:dist -- --project <id>`, `npm test`, `npm run test:emulator` (needs Java 21+), `npm run emulators`.

## Invariants
- Notes live at `users/{uid}/notes/{id}`; ownership is the path, enforced in `firestore.rules`, never by client fields.
- Content is stored as a Tiptap JSON string, never HTML.
- Every update must be `rev + 1` on the current revision (rules + transaction in `src/notesApi.ts`). Never add last-writer-wins or auto-merge.
- Deleting a note goes through `deleteNote(db, uid, id, expectedRev)` (transaction: compare `rev`, then delete), with the revision the user was looking at (`EditorHandle.hold()`); never a bare `deleteDoc`. Report a delete as done only after the server acknowledged it; a refused (stale) delete needs the user to review and confirm again. A delete's answer can arrive after its editor unmounted: set the terminal notice first and touch the editor only best-effort, so "pending" can never outlive an answer.
- Leaving a note (sign-out, switching) goes through `leaveNote` in `src/App.tsx`: save pending edits first, otherwise require an explicit discard. Per-note save state belongs to that note's `SaveController`; never mirror it in `App`.
- "Saved" is shown only after a server ack; failed saves keep the draft; remote snapshots never overwrite a dirty draft (`src/saveController.ts`).
- Leaving a note while the open note's delete is pending and the note holds unsaved edits is deferred, never offered as a silent discard (the edits are frozen by `hold()` and would be lost even if the delete is refused). Unresolved deletes are tracked in `unconfirmed` in `src/App.tsx`, separate from the dismissible notice: dismissing never forgets one; only server-authoritative data or a later definite answer clears it, and reconciliation never closes an editor that holds unsaved edits.
- Appearance preferences live at `users/{uid}/preferences/appearance` (owner-only, fixed value lists, no delete). The value lists exist in `src/appearance.ts` and `firestore.rules` and must change together (`tests/emulator/rules.test.ts` checks them). Saves go through `savePreferences` (a transaction, so offline fails visibly) and `PreferencesController`: show "Saved" only after a server ack, never let a remote update replace an unsaved local choice, keep nothing in `localStorage`, and remove the page attributes on unmount.
- Search stays client-side and reads only the `text` of Tiptap text nodes (`src/search.ts`); never match node names, attributes or raw JSON, and never write from search.
- Do not enable Firestore persistent cache without owner approval.
- Personal-only access: `firestore.rules` require **both** an allowlisted uid (`authorizedUsers/{uid}` with boolean `active == true`) **and** path ownership for every notes/preferences operation. The allowlist is closed to all clients (`allow read, write: if false`), fails closed (missing/malformed denies), is written only with privileged access (console/Admin), and never appears in the repo (no uid, no email, no client-supplied claim). The access-denied screen is explanation only, never enforcement. Changing the rules means extending `tests/emulator/allowlist.test.ts` and running `npm run test:emulator`.
- No secrets / service-account keys in the repo, in `VITE_*` variables or in the browser bundle. Web config values identify a project and are not secrets; admin tokens, private keys and service-account JSON are never added anywhere (do not ask for them in chat either).
- Production vs emulator: the dev server defaults to emulators; a production build never can (`src/firebaseConfig.ts`, `vite.config.ts`), and must pass `npm run verify:dist -- --project <id>` before any deployment. Never put `VITE_USE_EMULATORS=true` in `.env.local` (Vite reads it for builds).
- Project targeting: no `.firebaserc`, no default project. Every live `firebase` command names `--project <id>` explicitly, deploys only what was authorized (`--only firestore:rules` or `--only hosting`), and never reuses another project.

## Boundaries
No deploying, live Firebase project changes (project, Auth providers/domains, allowlist provisioning), billing, production rules changes, or touching real user data without explicit owner authorization. Use emulators and synthetic data. Authorization is per operation and per gate: live Firebase setup, Hosting deployment and Git-changing completion steps (`docs/DEPLOYMENT.md`) are separate, and approval for one is never approval for the next. Do not weaken rules to troubleshoot; recover with the previous restrictive rules or `ops/lockdown/`. Verification claims must separate emulator evidence from live evidence: local emulator sign-in is not verified Google OAuth, and a successful deploy command is not a verified release.
Changes to rules or sync logic need emulator tests run (`npm run test:emulator`) and reported honestly.
