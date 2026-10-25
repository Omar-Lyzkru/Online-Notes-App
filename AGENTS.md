# Agent guidance

**Stack (approved):** React + TypeScript + Vite, Firebase Auth (Google), Cloud Firestore, Firebase Hosting, Tiptap, plain CSS variables. No custom backend, no extra state framework.
**Out of scope:** AI, sharing/collaboration, folders, attachments, offline editing/persistent cache, advanced editor nodes.

## Commands
`npm run typecheck`, `npm run build`, `npm test`, `npm run test:emulator` (needs Java 21+), `npm run emulators`.

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
- No secrets / service-account keys in the repo.

## Boundaries
No deploying, live Firebase project changes, billing, production rules changes, or touching real user data without explicit owner authorization. Use emulators and synthetic data.
Changes to rules or sync logic need emulator tests run (`npm run test:emulator`) and reported honestly.
