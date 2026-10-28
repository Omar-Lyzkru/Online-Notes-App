import { createRoot } from 'react-dom/client'
import { ConfigError, resolveFirebaseSetup } from './firebaseConfig'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

// Check the configuration before anything initializes Firebase, so a bad one is explained on the page
// instead of leaving a blank screen or a half-initialized app. (Production builds are also checked at build time.)
try {
  resolveFirebaseSetup(import.meta.env, import.meta.env.PROD)
  void import('./App').then(({ default: App }) => root.render(<App />))
} catch (e) {
  if (!(e instanceof ConfigError)) throw e
  root.render(
    <main className="center">
      <h1>Online Notes</h1>
      <p role="alert" className="err">This build is not configured correctly, so it did not start.</p>
      <ul>{e.problems.map((p) => <li key={p}>{p}</li>)}</ul>
    </main>,
  )
}
