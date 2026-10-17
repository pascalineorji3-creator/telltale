// Admin only: creates a signed license key (for marketplaces without a license API).
const crypto = require("crypto");
const { b64u, mac, same } = require("../lib/session");

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  const admin = process.env.ADMIN_SECRET, secret = process.env.LICENSE_SECRET;
  if (!admin || !secret) return json(500, { error: "ADMIN_SECRET or LICENSE_SECRET is not set." });
  if (!same(event.headers["x-admin-secret"] || "", admin)) {
    await new Promise((r) => setTimeout(r, 800));
    return json(401, { error: "Wrong admin secret." });
  }
  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad request." }); }
  const email = String(b.email || "").trim().slice(0, 120);
  if (!email) return json(400, { error: "Enter the buyer's email." });
  const days = Math.max(0, Math.min(3650, Number(b.days) || 0));
  const payload = { e: email, x: days ? Date.now() + days * 864e5 : 0, id: crypto.randomBytes(5).toString("hex") };
  const body = b64u(JSON.stringify(payload));
  return json(200, { key: "TT-" + body + "." + mac(body, secret, "key"), id: payload.id, expires: payload.x });
};
