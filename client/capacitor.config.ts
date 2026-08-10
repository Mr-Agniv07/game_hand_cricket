import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the web client into a native Android app.
//
// The app is configured to load the LIVE site (server.url) rather than the bundled
// copy, so every web deploy (Netlify auto-builds from master) appears in the app
// instantly — no APK rebuild, no reinstall. The bundled `dist` stays as a fallback.
//
// Trade-off: the app needs internet to start (fine — it's online multiplayer).
// FOR A PLAY STORE RELEASE: remove the `server` block below to ship the self-
// contained bundled `dist` (Google prefers a fully bundled app), then rebuild.
const config: CapacitorConfig = {
  appId: 'com.agniv.cricflick',
  appName: 'Cric Flick',
  webDir: 'dist',
  server: {
    url: 'https://cricflick.netlify.app',
  },
};

export default config;
