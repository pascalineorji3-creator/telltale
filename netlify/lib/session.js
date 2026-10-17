// Shared helpers: signed tokens and key hashing. No database needed.
const crypto = require("crypto");

const b64u = (s) => Buffer.from(s).toString("base64url");
const mac = (data, secret, scope) =>
  crypto.createHmac("sha256", scope + ":" + secret).update(data).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function makeToken(payload, secret, ttlMs) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return body + "." + mac(body, secret, "sess");
}

function readToken(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split(".");
  if (!body || !sig || !same(mac(body, secret, "sess"), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

const keyId = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);

module.exports = { b64u, mac, same, makeToken, readToken, keyId };
