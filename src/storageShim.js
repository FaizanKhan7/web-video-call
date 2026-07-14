// Minimal shim for the `window.storage` API used by OpenLine.
// Real deployment needs a signaling server; this shim uses localStorage so
// two tabs of the SAME browser (same origin) can find each other and complete
// the WebRTC handshake — enough to smoke-test the app locally.
const PREFIX = "ols:";

const nowIso = () => new Date().toISOString();

function keys() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
  }
  return out;
}

window.storage = {
  async get(key) {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return null;
    return { value: raw, updatedAt: nowIso() };
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, updatedAt: nowIso() };
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
    return true;
  },
  async list(prefix = "") {
    return { keys: keys().filter((k) => k.startsWith(prefix)) };
  },
};
