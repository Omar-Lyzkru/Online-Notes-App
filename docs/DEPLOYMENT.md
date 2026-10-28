# Production setup, deployment and rollback

**Status: prepared, not executed.** Nothing in this document has been run against a live Firebase project. Every command below that names `<PROJECT_ID>` is a *live* operation and needs the owner's explicit authorization for that specific operation (see "Authorization gates"). Local verification (emulators, synthetic accounts) needs none. The project ID and the owner's uid do not exist yet and are never written into this repository; `<PROJECT_ID>` and `<OWNER_UID>` are placeholders.

Principles: the Firestore rules are the only enforcement (the Access-denied screen is explanation); everything fails closed (empty allowlist = nobody gets in); every live command names its project explicitly with `--project`; nothing is deployed that was not built from a reviewed commit; no step weakens the rules to make something work.

## Authorization gates
| Gate | Covers | Needs |
|---|---|---|
| 1 Local | code, emulators, docs | done (M4 branch), then independent review |
| 2 Live Firebase setup | project, products, Google provider, authorized domains, web app registration, Firestore database, rules deployment, UID discovery, allowlist provisioning, live rules verification | owner approval of the specific operations (request contents below) |
| 3 Hosting deployment | `firebase deploy --only hosting`, production smoke tests, real OAuth verification on the hosted origin | separate owner approval; not implied by gate 2 |
| 4 Completion | Git integration/publication, docs describing the verified state | separate approval for Git-changing operations |

**Gate 2 request** states: proposed project name/ID; the owner-controlled Google account that owns it; products to enable (Authentication with the Google provider, Cloud Firestore, Hosting; nothing else); billing (none: stay on the no-cost Spark plan; stop and ask if any step demands billing); Firestore location (permanent, owner chooses); authorized domains; how the owner's uid is identified and provisioned (below); the exact rules deployment; planned verification and failure response; any real-data operations (none planned: only synthetic data, only the owner's accounts).
**Gate 3 request** states: exact commit, build identification, project ID, Hosting site (default site, `https://<PROJECT_ID>.web.app`), security verification results, the rollback procedure, remaining limitations.

Never paste credentials, tokens or service-account keys into chat or the repository. The owner signs in to the Firebase CLI themselves (`firebase login`); no service account is used.

## 0. What is already prepared in the repository
- `firebase.json`: `firestore` (rules + empty indexes), `hosting` (`public: dist`, security and cache headers, no rewrites: the app has no client-side routes, so a catch-all would only mask missing files), emulators. It names no project. **There is no `.firebaserc` (and it is Git-ignored): never create a default project alias; always pass `--project`.** A bare `firebase deploy` then fails with "no active project" instead of guessing.
- `firestore.rules`: allowlist + ownership + validation (see `docs/ARCHITECTURE.md`). `ops/lockdown/`: deny-all ruleset and config for recovery.
- Production build safeguards (`vite.config.ts`, `src/firebaseConfig.ts`) and `scripts/verify-dist.mjs`.
- Tests proving the above: `npm test`, `npm run test:emulator`.

## 1. Dedicated Firebase project (gate 2)
1. In the Firebase console, signed in as the owner's Google account, create a **new** project dedicated to this app (Add project). Do not reuse an existing project. Disable Google Analytics (not needed). Record the project ID exactly (it cannot be changed) and the owner role under Project settings → Users and permissions.
2. Plan: **Spark (no cost)**. Do not upgrade to Blaze. Firestore, Authentication (Google) and Hosting for one user fit the free quotas (check the current quota numbers on the Firebase pricing page when authorizing). Cost note for this design: each rules-evaluated request that reaches the allowlist check is billed as one extra document read for `authorizedUsers/{uid}`; negligible for one user, but it counts against the free read quota.
3. Enable only: **Authentication**, **Cloud Firestore**, **Hosting**. Nothing else (no Storage, Functions, Analytics, App Check, etc.).
4. Create the Firestore database in **production mode** (locked rules), never test mode (test mode is open to everyone until its expiry). Choose the location deliberately: it is permanent.

## 2. Authentication (gate 2)
1. Authentication → Sign-in method → enable **Google** only; set the public-facing name and support email.
2. Authorized domains (Authentication → Settings): the defaults `<PROJECT_ID>.firebaseapp.com`, `<PROJECT_ID>.web.app` and `localhost` are what is needed. `localhost` is needed only for step 4 (uid discovery); the owner may remove it afterwards. Add nothing else (no custom domain).
3. Project settings → Your apps → add a **Web app**; copy its config (`apiKey`, `authDomain`, `projectId`, `appId`) into `.env.production.local` (Git-ignored; template `.env.production.example`). These are identifiers, not credentials. `authDomain` must be `<PROJECT_ID>.firebaseapp.com` or `<PROJECT_ID>.web.app`; the build checks this.
4. Anyone with a Google account can authenticate; Google Sign-In does not restrict who. That is why the allowlist exists. Do not assume an email address determines the uid.

## 3. Rules first: deploy the restrictive rules before anyone signs in (gate 2)
Pre-checks, on the reviewed commit with a clean tree:
```
git status --porcelain          # must print nothing
git rev-parse HEAD              # record it
npm ci && npm run test:emulator # must pass; the rules under test are the file being deployed
firebase login:list             # confirm the owner's account
firebase deploy --only firestore:rules --project <PROJECT_ID> --dry-run   # validates the rules against the live project without releasing them (confirm in the CLI output that nothing was released)
```
Deploy (rules only: `--only firestore:rules` does not touch indexes or Hosting):
```
firebase deploy --only firestore:rules --project <PROJECT_ID>
```
Expected state afterwards: the allowlist is **empty**, so every client request, including the owner's, is denied. Record the release time shown by the CLI and compare the console's Rules tab with `firestore.rules`.

Verify against the live project (unauthenticated, read-only, no data involved):
```
curl -s -o /dev/null -w '%{http_code}\n' "https://firestore.googleapis.com/v1/projects/<PROJECT_ID>/databases/(default)/documents/users/x/notes"   # expect 403
curl -s -o /dev/null -w '%{http_code}\n' "https://firestore.googleapis.com/v1/projects/<PROJECT_ID>/databases/(default)/documents/authorizedUsers"   # expect 403
```
**If the deployment fails:** the previously active rules stay in force (a new database in production mode is locked). Read the error, fix it in the repository through review, retry. Never "temporarily" relax a rule to get past a problem. If a bad ruleset was released, go to "Rollback" → rules.

## 4. Identify the owner's uid and provision the allowlist (gate 2)
The uid is Firebase's identifier for the owner's Google account in *this* project; it does not exist until that account has signed in once, and it is not derived from the email.
1. Create a local, Git-ignored `.env.development.local` containing `VITE_USE_EMULATORS=false` and the four web-config values; run `npm run dev` and open `http://localhost:5173`. Sign in with the **owner's Google account**. The Access-denied screen is the expected result (the allowlist is empty).
2. Console → Authentication → Users: find the row whose provider is Google and whose email is the owner's; copy its **User UID** (check it is the account you signed in with; if other users exist, do not guess). Stop the dev server and delete `.env.development.local`.
3. Console → Firestore Database → Start collection `authorizedUsers` → Document ID = the uid, pasted exactly (no spaces) → field `active`, type **boolean**, value `true` → Save. The console acts with project-owner privileges, which bypass the rules; nothing in the app can do this. (No Admin SDK or service account is needed; adding one would be a new decision.)
4. Never write the uid in the repository, in chat or in an issue. The console record is the single source of truth.
Revoking: set `active` to `false` or delete the document, in the console. Both are denied by the rules immediately for new requests.

Verify the live rules with **only expressly authorized accounts and synthetic data**:
- The owner's account (localhost dev server in live mode): signs in and reaches an empty notebook; create a note titled "synthetic test", edit, reload, delete it.
- A second, owner-controlled Google account that is **not** allowlisted: signs in and sees the Access-denied screen; the browser network panel shows `permission-denied` for the Firestore listen requests; nothing appears in `users/…` in the console for that account's uid.
- Unauthenticated curl checks above still 403.
If any denied path succeeds: **stop, do not proceed to hosting, run the lockdown (Rollback → rules) and report**. Full Google OAuth on the hosted origin cannot be verified here; it is part of gate 3.

## 5. Hosting release (gate 3)
Preconditions: gate 2 verified; independent review satisfied; owner approval for this release.
```
git status --porcelain                       # must print nothing; on the exact approved commit
git rev-parse HEAD                           # the commit being released: record it
unset NODE_ENV                               # the build refuses any value other than production
npm ci
npm test && npm run test:emulator            # report the counts
npm run build                                # reads .env.production.local; fails on missing/inconsistent config or any emulator flag
npm run verify:dist -- --project <PROJECT_ID>
find dist -type f | sort | xargs sha256sum > build.sha256   # build identification (keep outside the repo)
sha256sum build.sha256
```
Check that `.env.production.local` names the project you are about to deploy (the verify step confirms the bundle does). Deploy exactly this and nothing else:
```
firebase deploy --only hosting --project <PROJECT_ID> -m "<commit sha>"
```
Target: the project's default Hosting site, expected URL `https://<PROJECT_ID>.web.app` (also `https://<PROJECT_ID>.firebaseapp.com`). Do not redeploy rules, change Auth settings or enable services in the same step.

Provenance check: for each file in `dist/`, download the deployed copy (`curl -s https://<PROJECT_ID>.web.app/<path> | sha256sum`) and compare with `build.sha256`; the Hosting release history shows the `-m` commit label. Only when both match is "this deployed build is commit X" a verified statement.

### Post-deployment verification (use the hosted URL, authorized accounts, synthetic data)
1. HTTPS site loads; response headers include `X-Content-Type-Options`, `X-Frame-Options`, and `Cache-Control: no-cache` on `/`.
2. Real Google OAuth succeeds for the owner's account on the hosted origin (popup from `https://<PROJECT_ID>.web.app`).
3. The owner reaches its own notes. 4. The non-allowlisted second account is denied at the Firestore layer and sees the Access-denied screen. 5. Direct Firestore requests without the allowlist are refused (curl checks from §3; a signed-in, non-allowlisted ID token gets 403 on `users/<its uid>/notes`).
6. Create a note → reload → still there. 7. Edit on the laptop → appears on the desktop PC; edit on the desktop → appears on the laptop. 8. Search finds it. 9. Bold/heading/list survive a reload. 10. Theme, background, font size persist after reload and update the other device.
11. Revision conflict (edit the same note on both devices while one is offline) shows the recovery choices; a failed save (go offline, edit) says "Save failed" and keeps the draft; delete reports success only after the server answered.
12. DevTools Network: all requests go to `<PROJECT_ID>` Firebase endpoints; none to `localhost`. The `dist` was verified credential-free by `verify:dist`.
13. Record anything that could not be verified (for example a missing second physical device) as a gap; emulator results never substitute for these.

## Pre-deployment checklist (all must be yes)
Intended project ID written down and equal in `--project`, `.env.production.local` and the console · owner uid provisioned in `authorizedUsers` (and never in the repo) · rules deployed and §3 checks done · Google provider on and authorized domains as listed · production config validated by `npm run build` · `verify:dist` ok for this project · exact reviewed commit, clean tree · no credential files (`git status`, `git ls-files | grep -iE 'adminsdk|service-account|\.env'` shows only the `*.example` templates).

## Rollback and recovery
Hosting rollback restores the **site**, never Firestore data. Neither rollback below deletes or changes notes, preferences or the allowlist. Live rollback operations also need authorization.

**Hosting.** 1. Identify the last known-good release: console → Hosting → Release history (the `-m` label is the commit). The very first deployment has **no** earlier release to restore; in that case redeploy a fixed build, or, in an emergency, stop serving with `firebase hosting:disable --project <PROJECT_ID>` (reversible by deploying again; data stays protected by the rules either way). 2. Revert: in the release history, roll back to the earlier release; or check out that commit, repeat §5 (build, verify, deploy) for it. 3. Verify: HTTPS loads, sign-in, smoke tests 2–4 and 6.

**Rules.** 1. Identify the last known-good ruleset: console → Firestore → Rules → history, or `git show <good commit>:firestore.rules`. 2. If it is unclear whether the newest rules are safe, first lock everything down, which keeps unauthorized users (and everyone else) denied while you work:
```
firebase deploy --only firestore:rules --project <PROJECT_ID> --config ops/lockdown/firebase.json
```
(`ops/lockdown/firestore.rules` denies all requests. Emulator-verified: `--config` loads that file and the owner is then denied; the live deploy uses the same configuration loading but was not run.) 3. Then restore the known-good rules: check out that commit and run the §3 deploy, or republish the old version from the console history; re-run the §3 and §4 verifications. 4. Never replace rules with an allow-all file, never delete `authorizedUsers` or any data as a recovery step.

**Allowlist mistakes.** Wrong uid or field type: fix in the console (the rules treat anything other than boolean `true` as not allowlisted, which fails closed). Owner locked out: confirm the uid in Authentication → Users and the document's `active` boolean.

**Data.** Rules and Hosting rollbacks do not restore notes. No export or backup is configured, because managed Firestore exports need the paid plan (not enabled). If the owner wants backups, that is a billing decision to take separately.

## Known limitations of this plan
- Real Google OAuth, authorized-domain behavior, the live rules and the hosted origin are unverified until gates 2 and 3 are executed. A first sign-in popup on `*.web.app` using the `firebaseapp.com` auth domain (or the reverse) is expected to work but is untested.
- No Content-Security-Policy header is set: the Firebase Auth popup needs Google script origins and a wrong policy would break sign-in; it should be added only after it can be tested against the real project.
- Removing an allowlist entry blocks new requests at once (emulator and browser verified for writes); an already-open snapshot listener may keep delivering until it restarts (not verified). Treat a revoked session as ended.
- A modified client signed in as the approved owner can bypass the app's expected-revision delete (accepted by the owner; see `docs/DECISIONS.md`).
