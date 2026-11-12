// Shared AI call: ask Gemini (preferred, free tier) or Claude for JSON that matches a schema.
// Used by voice → Do's, email → Do's and email reply suggestions.

import Anthropic from '@anthropic-ai/sdk';
import { geminiKey } from './secrets.js';

const CLAUDE_MODEL = 'claude-opus-5-5';
const GEMINI_MODEL_DEFAULT = 'gemini-3.6-flash'; // stable Flash with a free tier; override with GEMINI_MODEL

export class AIError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Which provider this household would use, without calling it.
export async function aiProvider(env, db, hh) {
  const gem = await geminiKey(env, db, hh); // Cloudflare secret, or the key this household saved in Settings
  if (gem.key) return { provider: 'gemini', key: gem.key };
  if (env.ANTHROPIC_API_KEY) return { provider: 'claude', key: null };
  return { provider: null, key: null };
}

// ---- Gemini (generateContent REST, JSON-schema constrained output) ----
async function callGemini(env, apiKey, { system, user, schema, maxTokens = 8192, thinking = 'LOW' }) {
  const model = env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'; // override only for local tests
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const makeBody = (withThinking) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      maxOutputTokens: maxTokens,
      ...(withThinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
    },
  });
  const post = (b) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(b),
  });

  let res = await post(makeBody(true));
  if (res.status === 400) {
    // Some models reject thinkingConfig; retry once without it.
    const errText = await res.text();
    if (/thinking/i.test(errText)) res = await post(makeBody(false));
    else throw new AIError(`AI error (400): ${errText.slice(0, 300)}`);
  }
  if (res.status === 429) throw new AIError('Free AI quota used up for now — try again in a minute (daily limits reset at midnight Pacific).', 429);
  if (res.status === 401 || res.status === 403) throw new AIError('The Gemini key was rejected — paste a new one in ⚙︎ Settings → AI for voice.', 500);
  if (!res.ok) throw new AIError(`AI error (${res.status}): ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new AIError("The AI couldn't process that request. Try rephrasing.", 422);
  const cand = data.candidates?.[0];
  if (!cand) throw new AIError('AI returned no answer — try again.');
  if (cand.finishReason === 'MAX_TOKENS') throw new AIError('That was too long to process at once — split it up.', 422);
  if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    throw new AIError("The AI couldn't process that request. Try rephrasing.", 422);
  }
  // Skip any "thought" parts; the answer is the JSON text.
  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new AIError('AI returned an unreadable answer — try again.');
  }
}

// ---- Claude (alternative provider) ----
async function callClaude(env, { system, user, schema, effort = 'low' }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new AIError('AI is busy — try again in a minute.', 429);
    if (err instanceof Anthropic.AuthenticationError) throw new AIError('ANTHROPIC_API_KEY is invalid.', 500);
    if (err instanceof Anthropic.APIError) throw new AIError(`AI error (${err.status}): ${err.message}`);
    throw new AIError('Could not reach the AI service.');
  }
  if (response.stop_reason === 'refusal') throw new AIError("The AI couldn't process that request. Try rephrasing.", 422);
  if (response.stop_reason === 'max_tokens') throw new AIError('That was too long to process at once — split it up.', 422);
  const textBlock = response.content.find((b) => b.type === 'text');
  try {
    return JSON.parse(textBlock?.text || '');
  } catch {
    throw new AIError('AI returned an unreadable answer — try again.');
  }
}

// opts: { system, user, schema, maxTokens?, thinking? ('LOW'|'MEDIUM'), effort? ('low'|'medium') }
export async function generateJSON(env, db, hh, opts) {
  const p = await aiProvider(env, db, hh);
  if (!p.provider) throw new AIError('AI is off: add your free Gemini key in ⚙︎ Settings → AI for voice.', 503);
  const out = p.provider === 'gemini' ? await callGemini(env, p.key, opts) : await callClaude(env, opts);
  return { provider: p.provider, data: out };
}
