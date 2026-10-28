/**
 * Shown when the server refuses a signed-in account any access to the notebook. The account authenticated, but it is
 * not on the owner's allowlist (enforced by the Firestore rules; this screen is only the explanation). It carries
 * no notes, settings or allowlist details, and nothing was loaded for this account.
 */
export function AccessDenied({ who, error, onSignOut }: { who: string; error: string; onSignOut: () => void }) {
  return (
    <main className="center">
      <h1>Online Notes</h1>
      <p role="alert"><strong>Access denied.</strong> {who} is signed in, but this account is not authorized to use this app.</p>
      <p>This is a private, personal notebook. No notes or settings were loaded for this account.</p>
      <p>If you expected access, sign out and sign in with the Google account the owner approved.</p>
      <button onClick={onSignOut}>Sign out</button>
      {error && <p role="alert" className="err">Sign-out failed: {error}</p>}
    </main>
  )
}
