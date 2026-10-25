# Decisions

## Owner-approved
- Browser app; React, TypeScript, Vite; Firebase Auth with Google Sign-In; Cloud Firestore; Firebase Hosting; Tiptap; CSS variables/plain CSS.
- Online-first; private per-user notes; automatic saving and cross-device sync.
- MVP formatting: bold, italics, headings, bullet lists, checklists.
- Unsaved edits must never be silently overwritten; conflicts need a visible, non-destructive recovery path.
- **Revision-aware deletion** (owner-approved, Option B). A delete carries the revision of the note the user intended to delete and is checked against the stored revision atomically (Firestore transaction). A matching revision permits the delete; a mismatch deletes nothing (the newer content survives) and tells the user the note changed. The user must then review the updated note and explicitly confirm deletion again; the app never retries a refused delete on its own, and merely receiving a newer revision does not authorize deleting it. Revision adoption and deletion authorization are separate things: a clean editor adopts and displays incoming revisions automatically, without any confirmation (as it does for any remote update), and loads the newer revision of a refused delete the same way; an editor holding unsaved edits shows its usual conflict choices instead. A delete expects the revision that is on screen at the moment the user confirms it, so a newer revision the editor has adopted and shown can be deleted by a new, explicit confirmation, while a revision the editor has not adopted is never the expected one. The transactional check runs on every attempt, so a further update blocks it again. Ownership and existing revision rules are unchanged. No version history, merging or collaboration.
- **Pending-deletion safety** (owner-approved). A delete is never reported as successful until the server acknowledges it. Offline deletes may simply fail with clear feedback. Pending, failed and unknown outcomes are represented as such, and signing out with an unresolved delete must not imply it succeeded. Online-first stays: no durable offline deletion queue.
- Search and appearance customization are planned for Milestone 2 (not yet implemented). Hosting deploy is planned, not done.

## Engineering choices (not owner decisions)
- Revision counter (`rev`) + transaction + rules for optimistic concurrency.
- Content stored as JSON string; 800 ms debounced autosave.
- Conflict choices offered to the user: keep mine, use other, save mine as copy.
- Deletion is a client-side Firestore transaction (read, compare `rev`, delete) in `deleteNote`. Security rules cannot compare a client-supplied revision on delete, so they keep enforcing ownership only. The expected revision is the one the editor shows when the user confirms (the open note's `baseRev`, including its own acknowledged saves, excluding remote changes it has not adopted).
- An unconfirmed delete is resolved only by server-authoritative listener data (a snapshot that is not from the cache, has no unacknowledged local writes, and no longer lists the note); a cached or optimistic disappearance is never treated as confirmation. The user may dismiss the notice, which forgets the uncertainty.

*Implementation status of the approved items above is in `PROJECT_STATE.md`.*
