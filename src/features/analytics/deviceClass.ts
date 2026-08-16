import type { DeviceClass } from './funnelTypes.js';

// Coarse device classification - deliberately NOT fingerprinting. We store only one of
// six buckets; the raw user-agent string is never persisted. `pwa` comes from the
// client (display-mode: standalone is only knowable client-side).
export function classifyDevice(userAgent: string | undefined, pwa: boolean): DeviceClass {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua) return 'other';
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isAndroid = ua.includes('android');
  if (isIos) return pwa ? 'ios_pwa' : 'ios_safari';
  if (isAndroid) return pwa ? 'android_pwa' : 'android_chrome';
  if (/windows|macintosh|linux/.test(ua) && !ua.includes('mobile')) return 'desktop';
  return 'other';
}
