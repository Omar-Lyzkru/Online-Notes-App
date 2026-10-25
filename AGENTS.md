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
- Do not enable Firestore persistent cache without owner approval.
- No secrets / service-account keys in the repo.

## Boundaries
No deploying, live Firebase project changes, billing, production rules changes, or touching real user data without explicit owner authorization. Use emulators and synthetic data.
Changes to rules or sync logic need emulator tests run (`npm run test:emulator`) and reported honestly.
