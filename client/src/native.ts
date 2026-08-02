import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';

/**
 * Native-only UI setup, run once at startup. Hides the Android status bar so the
 * game runs fullscreen. A no-op on the web build (Capacitor.isNativePlatform() is
 * false there), and fully guarded so it can never break app boot.
 */
export async function setupNativeUi(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await StatusBar.hide();
  } catch {
    /* ignore — cosmetic only */
  }
}
