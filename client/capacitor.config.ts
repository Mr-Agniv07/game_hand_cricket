import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the built web client (client/dist) into a native Android app.
// The app loads the bundled SPA from the device's filesystem and connects to the
// remote game server over wss:// — the server URL is baked into the build at
// build time via VITE_SERVER_URL (see client/.env.production).
const config: CapacitorConfig = {
  appId: 'com.agniv.cricflick',
  appName: 'Cric Flick',
  webDir: 'dist',
};

export default config;
