// iPhone app (Capacitor) bridges. On the website these are all null and the web code paths run.
// Plugins are reached through Capacitor's global bridge, so no bundler is needed.
const Cap = globalThis.Capacitor;
const register = globalThis.capacitorExports?.registerPlugin ?? Cap?.registerPlugin; // capacitor.js, injected into the app build
// Without the runtime the app falls back to the web code paths instead of crashing.
export const isNative = !!Cap?.isNativePlatform?.() && typeof register === 'function';
const plugin = (name) => (isNative ? register(name) : null);

export const Haptics = plugin('Haptics');
export const Share = plugin('Share');
export const Filesystem = plugin('Filesystem');
export const LocalNotifications = plugin('LocalNotifications');
export const StatusBar = plugin('StatusBar');
export const BackgroundGeolocation = plugin('BackgroundGeolocation');
export const TextToSpeech = plugin('TextToSpeech');
export const KeepAwake = plugin('KeepAwake');
export const App = plugin('App');

// ---------- haptics ----------
const HAPTIC = {
  pop: ['impact', 'LIGHT'], flip: ['impact', 'LIGHT'], right: ['impact', 'MEDIUM'],
  ding: ['notification', 'SUCCESS'], card: ['notification', 'SUCCESS'], win: ['notification', 'SUCCESS'], wrong: ['notification', 'ERROR'],
};
export function nativeHaptic(kind) {
  const [type, style] = HAPTIC[kind] || ['impact', 'LIGHT'];
  return (type === 'impact' ? Haptics.impact({ style }) : Haptics.notification({ type: style })).catch(() => {});
}

// ---------- speech (keeps talking with the screen locked) ----------
export function nativeSpeak(text) {
  TextToSpeech.stop().catch(() => {});
  return TextToSpeech.speak({ text, lang: 'en-US', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' }).catch(() => {});
}

// ---------- share an image ----------
export async function nativeShareImage(canvas, { title, text, filename }) {
  const data = canvas.toDataURL('image/png').split(',')[1];
  const { uri } = await Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
  await Share.share({ title, text, files: [uri], dialogTitle: title });
}

// ---------- driving: location with the screen locked ----------
let watcherId = null;
export async function startBackgroundLocation(onFix, onError) {
  watcherId = await BackgroundGeolocation.addWatcher({
    backgroundTitle: 'FieldSight is reading the fields',
    backgroundMessage: 'Naming the crops beside the road as you drive.',
    // stale: true so a parked phone gets its cached fix right away instead of waiting to move 10 m.
    requestPermissions: true, stale: true, distanceFilter: 10,
  }, (loc, err) => {
    if (err) { onError?.(err); return; }
    if (!loc) return;
    const t = loc.time || Date.now(), old = Date.now() - t > 30000;
    onFix({
      lat: loc.latitude, lon: loc.longitude, t, acc: loc.accuracy,
      speed: old || !(loc.speed >= 0) ? null : loc.speed, heading: old || !(loc.bearing >= 0) ? null : loc.bearing, // iOS uses -1 for unknown
    });
  });
  return watcherId;
}
export async function stopBackgroundLocation() {
  if (watcherId) await BackgroundGeolocation.removeWatcher({ id: watcherId }).catch(() => {});
  watcherId = null;
}

// ---------- daily "crop of the day" reminder ----------
export async function scheduleDailyCrops(pick, label) {
  const perm = await LocalNotifications.requestPermissions();
  if (perm.display !== 'granted') return false;
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
  const notifications = [];
  for (let d = 1; d <= 14; d++) {
    const at = new Date(); at.setDate(at.getDate() + d); at.setHours(9, 0, 0, 0);
    const code = pick(at);
    notifications.push({ id: 1000 + d, title: '⭐ Crop of the day', body: `${label(code)}. Tap to see where it grows near you.`, schedule: { at } });
  }
  await LocalNotifications.schedule({ notifications });
  return true;
}
export async function cancelDailyCrops() {
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
}
