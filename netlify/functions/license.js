// Telltale Pro: checks a license key with the marketplace, registers the device,
// and returns a short-lived signed token that other server functions trust.
const { mac, same, makeToken, keyId } = require("../lib/session");

const SECRET = process.env.LICENSE_SECRET;
const PROVIDER = (process.env.LICENSE_PROVIDER || "signed").toLowerCase();
const TTL = 12 * 60 * 60 * 1000; // token lifetime: 12 hours, then the license is re-checked
const hits = new Map();
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

// ---- Lemon Squeezy: real device activation with an activation limit ----
async function lsCall(path, params) {
  const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/" + path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  return r.json().catch(() => ({}));
}
const lsProductOk = (r) => !process.env.LS_PRODUCT_ID || String(r.meta && r.meta.product_id) === String(process.env.LS_PRODUCT_ID);
const lsStatusOk = (r) => { const s = r.license_key && r.license_key.status; return s === "active" || s === "inactive"; };

// ---- Each provider returns { ok, error?, instance?, exp? } ----
const providers = {
  async lemonsqueezy(action, { key, instance, device }) {
    if (action === "activate") {
      const r = await lsCall("activate", { license_key: key, instance_name: device });
      if (!r.activated) return { ok: false, error: r.error || "That license key could not be activated." };
      if (!lsProductOk(r) || !lsStatusOk(r)) {
        if (r.instance) await lsCall("deactivate", { license_key: key, instance_id: r.instance.id });
        return { ok: false, error: "That license key is not valid for Telltale Pro." };
      }
      return { ok: true, instance: r.instance && r.instance.id };
    }
    if (action === "check") {
      const params = { license_key: key };
      if (instance) params.instance_id = instance;
      const r = await lsCall("validate", params);
      return r.valid && lsProductOk(r) && lsStatusOk(r) ? { ok: true, instance } : { ok: false, error: "This license is no longer valid." };
    }
    if (action === "deactivate") {
      await lsCall("deactivate", { license_key: key, instance_id: instance || "" });
      return { ok: true };
    }
    return { ok: false, error: "Unknown action." };
  },

  // Gumroad: refund/dispute checks, and the "uses" counter acts as a device cap.
  async gumroad(action, { key }) {
    const pid = process.env.GUMROAD_PRODUCT_ID;
    const max = Number(process.env.MAX_DEVICES || 2);
    if (!pid) return { ok: false, error: "The server is not configured for this marketplace." };
    const verify = async (inc) => {
      const r = await fetch("https://api.gumroad.com/v2/licenses/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ product_id: pid, license_key: key, increment_uses_count: inc ? "true" : "false" })
      });
      return r.json().catch(() => ({}));
    };
    const good = (r) => {
      const p = r.purchase || {};
      return r.success && !p.refunded && !p.chargebacked && !(p.disputed && !p.dispute_won) && !p.subscription_ended_at && !p.subscription_failed_at;
    };
    if (action === "deactivate") return { ok: true };
    const r0 = await verify(false);
    if (!good(r0)) return { ok: false, error: r0.success ? "This license is no longer valid." : "That license key was not recognized." };
    if (action === "activate") {
      if (Number(r0.uses || 0) >= max) return { ok: false, error: "This license has reached its device limit." };
      await verify(true);
    }
    return { ok: true };
  },

  // Signed keys: for any marketplace without a license API. You create keys yourself
  // (admin page) and paste them into the marketplace's delivery message.
  async signed(action, { key, email }) {
    const bad = { ok: false, error: "That license key was not recognized." };
    const [body, sig] = String(key).replace(/^TT-/, "").split(".");
    if (!body || !sig || !same(mac(body, SECRET, "key"), sig)) return bad;
    let p;
    try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return bad; }
    if (p.x && p.x < Date.now()) return { ok: false, error: "This license has expired." };
    const revoked = (process.env.REVOKED_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (revoked.includes(p.id)) return { ok: false, error: "This license is no longer valid." };
    if (action === "activate" && p.e) {
      if (!email) return { ok: false, error: "Enter the email this license was issued to." };
      if (String(email).trim().toLowerCase() !== p.e.toLowerCase()) return { ok: false, error: "That email does not match this license." };
    }
    return { ok: true, exp: p.x || 0 };
  }
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!SECRET) return json(500, { error: "The server is missing LICENSE_SECRET." });

  // slow down key guessing
  const ip = ((event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "anon") + "").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 12) return json(429, { error: "Too many attempts. Wait a minute and try again." });
  recent.push(now);
  hits.set(ip, recent);

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad request." }); }
  const action = b.action;
  if (!["activate", "check", "deactivate"].includes(action)) return json(400, { error: "Unknown action." });
  const key = String(b.key || "").trim().slice(0, 400);
  if (!key) return json(400, { error: "Enter your license key." });
  const handler = providers[PROVIDER];
  if (!handler) return json(500, { error: "The server has an unknown LICENSE_PROVIDER." });

  let res;
  try {
    res = await handler(action, { key, instance: String(b.instance || "").slice(0, 100), device: String(b.device || "Browser").slice(0, 60), email: b.email });
  } catch {
    return json(502, { error: "Could not reach the license service. Try again." });
  }
  if (!res.ok) return json(403, { error: res.error || "License not valid." });
  if (action === "deactivate") return json(200, { ok: true });

  const token = makeToken({ k: keyId(key), p: PROVIDER }, SECRET, TTL);
  return json(200, { ok: true, token, instance: res.instance || b.instance || "", expires: res.exp || 0 });
};
