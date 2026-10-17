// Telltale: serverless writing-signal analysis using Gemini. The key stays on the server.
// Pro licence tokens unlock longer text, higher limits and deep document review.
const { readToken } = require("../lib/session");

const PROMPT = `You analyze writing for patterns often associated with AI-generated text. You can NOT prove who wrote something, and you must never claim certainty. Human writers, especially non-native English speakers and students, are often wrongly flagged, so be conservative.
Return ONLY JSON in this shape:
{"level":"low"|"mixed"|"high","summary":"2 sentences in plain language","signals":[{"quote":"exact excerpt of at most 12 words from the text","why":"short reason"}],"human_markers":["short observation of natural, personal or specific writing"],"caveat":"one sentence reminding the reader this is not proof"}
Use "high" only when many strong patterns appear together. Give at most 5 signals and 3 human_markers. Quote text exactly as written.`;

const REWRITE_PROMPT = `You are a thoughtful line editor helping a writer make their own draft more specific and personal. Pick up to 3 sentences from the text that are the most generic, vague or formulaic. For each, suggest a rewrite that keeps the meaning and the writer's tone but is more concrete. Never invent facts, names, numbers or examples: where a real detail is needed, leave a bracketed placeholder such as [add a real example from your own experience]. Return ONLY JSON: {"rewrites":[{"original":"exact sentence from the text","better":"your suggested rewrite","why":"short reason"}]}`;

const DOC_PROMPT = `You review a longer document paragraph by paragraph for patterns often associated with AI-generated text. You can NOT prove authorship and must never claim certainty. Human writers, especially students and non-native English speakers, are often wrongly flagged, so be conservative and judge each paragraph on specific patterns only.
The paragraphs are numbered like [1], [2]. Return ONLY JSON: {"overall":{"level":"low"|"mixed"|"high","summary":"2 sentences in plain language"},"paragraphs":[{"n":1,"level":"low"|"mixed"|"high","note":"one short sentence naming the specific pattern, or what sounds natural"}]}
Include every numbered paragraph, in order.`;

const hits = new Map();

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const send = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  if (event.httpMethod !== "POST") return send(405, { error: "Use POST." });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(500, { error: "The server is missing its GEMINI_API_KEY setting." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return send(400, { error: "Bad request." }); }

  const pro = !!readToken(body.token, process.env.LICENSE_SECRET);
  const mode = body.mode === "rewrite" ? "rewrite" : body.mode === "document" ? "document" : "analyze";
  if (mode === "document" && !pro) return send(403, { error: "Deep document review is a Pro feature. Sign in on the Pro page." });

  const ip = ((event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "anon") + "").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= (pro ? 20 : 5)) return send(429, { error: "Too many requests. Wait a minute and try again." });
  recent.push(now);
  hits.set(ip, recent);

  const text = String(body.text || "").trim().slice(0, pro ? 30000 : 8000);
  if (text.split(/\s+/).filter(Boolean).length < 60) return send(400, { error: "Paste at least 60 words so there is enough to analyze." });

  let prompt = mode === "rewrite" ? REWRITE_PROMPT : mode === "document" ? DOC_PROMPT : PROMPT;
  let input = text;
  if (mode === "document") {
    const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 15).slice(0, 40);
    if (!paras.length) return send(400, { error: "Separate paragraphs with blank lines (each 15+ words)." });
    input = paras.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
  }

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${prompt}\n\nTEXT:\n${input}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: mode === "document" ? 3500 : 1500, responseMimeType: "application/json" }
      })
    });
  } catch {
    return send(502, { error: "Could not reach the AI service. Try again." });
  }

  if (res.status === 429) return send(429, { error: "The free AI quota is used up for now. Try again later." });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return send(502, { error: `AI service error ${res.status}: ${detail.slice(0, 200)}` });
  }

  const data = await res.json().catch(() => ({}));
  const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!out) return send(502, { error: "The AI returned no answer. Try again." });
  try {
    return send(200, { result: JSON.parse(out.replace(/^```(?:json)?|```$/g, "").trim()), pro });
  } catch {
    return send(502, { error: "The AI answer could not be read. Try again." });
  }
};
