// POST /api/parse { text } -> proposed tickets extracted from a spoken/typed brain dump.
// Provider: Google Gemini when GEMINI_API_KEY is set (free tier), otherwise Claude when
// ANTHROPIC_API_KEY is set. Both are forced to answer in RESPONSE_SCHEMA, so the reply is
// always valid JSON in our shape; the prompt, dictionary and post-checks are shared. Nothing is saved here — the client shows the
// proposals for review and then creates the ones the user keeps via POST /api/tickets.

import Anthropic from '@anthropic-ai/sdk';
import { readDictionary, aiGlossary } from '../../lib/dictionary.js';

const CLAUDE_MODEL = 'claude-opus-5-5';
const GEMINI_MODEL_DEFAULT = 'gemini-3.6-flash'; // stable Flash with a free tier; override with GEMINI_MODEL
const CATEGORIES = ['repair', 'cleaning', 'yard', 'errand', 'kids', 'admin', 'project', 'general'];
const SIZES = [15, 30, 60, 180, 480];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'description', 'steps', 'shopping', 'priority', 'category', 'location',
    'estimate_min', 'due_date', 'recur_days', 'duplicate_of', 'source_quote',
  ],
  properties: {
    title: { type: 'string', description: 'Imperative, specific, <= 60 chars. e.g. "Replace kitchen faucet washer"' },
    description: { type: 'string', description: 'Context she gave, in plain words. Empty string if none.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Concrete steps to complete it, 0-6 short items.' },
    shopping: { type: 'array', items: { type: 'string' }, description: 'Parts/supplies likely needed. Empty if none.' },
    priority: { type: 'integer', enum: [1, 2, 3, 4] },
    category: { type: 'string', enum: CATEGORIES },
    location: { type: 'string', description: 'Room/area, or empty string.' },
    estimate_min: { type: 'integer', enum: SIZES },
    due_date: { type: 'string', description: 'YYYY-MM-DD if a deadline was stated or clearly implied, else empty string.' },
    recur_days: { type: 'integer', description: '0 unless it is explicitly recurring (7, 14, 30, 90, 180, 365).' },
    duplicate_of: { type: 'integer', description: 'ID of an existing open ticket that is the same task, else 0.' },
    source_quote: { type: 'string', description: 'The short part of the transcript this came from.' },
  },
};

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'questions', 'not_tasks'],
  properties: {
    items: { type: 'array', items: ITEM_SCHEMA },
    questions: {
      type: 'array', items: { type: 'string' },
      description: 'Clarifying questions where the request is too vague to act on (max 3).',
    },
    not_tasks: {
      type: 'array', items: { type: 'string' },
      description: 'Things said that are not actionable tasks (venting, info, reminders for her). Short.',
    },
  },
};

const SYSTEM = `You turn a household member's spoken, rambling list of requests into clean, actionable chore tickets for a home "help desk".

The input is a raw speech-to-text transcript: expect run-on sentences, filler words, mis-heard words, and several requests mashed together. Your job:
- Split it into one ticket per distinct job. "Fix the faucet and also the closet door squeaks" is two tickets. Do not split one job into micro-steps; put those in "steps".
- Write titles as specific imperative actions a person can finish ("Tighten loose hinge on hall closet door"), not vague topics ("closet").
- Correct obvious speech-to-text errors from context (e.g. "gutter" mis-heard as "butter").
- Priority: 1 = safety hazard, active leak, or broken essential (no heat, no water, toilet won't flush) or she says today/now/urgent; 2 = she says soon / this week or there's a near deadline; 3 = normal request (default); 4 = someday / would be nice / big project idea.
- Estimate realistically for a reasonably handy person including setup and cleanup: 15, 30, 60, 180 or 480 minutes.
- Resolve relative dates ("by Friday", "before mom visits on the 20th", "next weekend") to YYYY-MM-DD using today's date. Leave empty if none was given.
- If an existing open ticket is clearly the same job, set duplicate_of to its id (still return the item).
- Only include supplies in "shopping" when the job plausibly needs a purchase.
- Venting, general complaints, or information with no action belong in not_tasks, not items.
- If something is too vague to act on, still make your best-guess ticket, and add one short clarifying question.
- Use the household dictionary when one is given: write names exactly as spelled there, fix transcript words that match a listed mis-hearing (or clearly sound like a listed name in context), and expand household shorthand into what it means — a shorthand that means several jobs becomes several tickets. Put useful notes from the dictionary (who someone is, a phone number) in the description.
Never invent requests that weren't said.
The household calls these items "Do's" (one "Do"). In any text a person will read (questions, not_tasks, descriptions), say "Do" or "Do's", never "ticket".`;

class ParseError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// ---- Gemini (generateContent REST, JSON-schema constrained output) ----
async function callGemini(env, userMsg) {
  const model = env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'; // override only for local tests
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const makeBody = (withThinking) => ({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192,
      // Simple extraction: keep reasoning short for speed and to stay inside free-tier token limits.
      ...(withThinking ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
    },
  });
  const post = (b) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(b),
  });

  let res = await post(makeBody(true));
  if (res.status === 400) {
    // Some models reject thinkingConfig; retry once without it.
    const errText = await res.text();
    if (/thinking/i.test(errText)) res = await post(makeBody(false));
    else throw new ParseError(`AI error (400): ${errText.slice(0, 300)}`);
  }
  if (res.status === 429) throw new ParseError('Free AI quota used up for now — try again in a minute (daily limits reset at midnight Pacific).', 429);
  if (res.status === 401 || res.status === 403) throw new ParseError('GEMINI_API_KEY is invalid or not allowed for this model.', 500);
  if (!res.ok) throw new ParseError(`AI error (${res.status}): ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new ParseError("The AI couldn't process that request. Try rephrasing.", 422);
  const cand = data.candidates?.[0];
  if (!cand) throw new ParseError('AI returned no answer — try again.');
  if (cand.finishReason === 'MAX_TOKENS') throw new ParseError('That was too long to process at once — split it up.', 422);
  if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    throw new ParseError("The AI couldn't process that request. Try rephrasing.", 422);
  }
  // Skip any "thought" parts; the answer is the JSON text.
  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new ParseError('AI returned an unreadable answer — try again.');
  }
}

// ---- Claude (kept as an alternative provider) ----
async function callClaude(env, userMsg) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low', // simple extraction; keeps it fast and cheap
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new ParseError('AI is busy — try again in a minute.', 429);
    if (err instanceof Anthropic.AuthenticationError) throw new ParseError('ANTHROPIC_API_KEY is invalid.', 500);
    if (err instanceof Anthropic.APIError) throw new ParseError(`AI error (${err.status}): ${err.message}`);
    throw new ParseError('Could not reach the AI service.');
  }
  if (response.stop_reason === 'refusal') throw new ParseError("The AI couldn't process that request. Try rephrasing.", 422);
  if (response.stop_reason === 'max_tokens') throw new ParseError('That was too long to process at once — split it up.', 422);
  const textBlock = response.content.find((b) => b.type === 'text');
  try {
    return JSON.parse(textBlock?.text || '');
  } catch {
    throw new ParseError('AI returned an unreadable answer — try again.');
  }
}

export async function onRequestPost({ request, env }) {
  const provider = env.GEMINI_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY ? 'claude' : null;
  if (!provider) {
    return json({ error: 'Voice parsing is not set up: add the GEMINI_API_KEY secret in Cloudflare.' }, 503);
  }
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return json({ error: 'Nothing to parse' }, 400);
  if (text.length > 20000) return json({ error: 'That is a lot! Please split it into smaller chunks.' }, 400);

  // Give the model the open tickets so it can flag duplicates.
  const { results: open } = await env.DB.prepare(
    "SELECT id, title FROM tickets WHERE status NOT IN ('resolved','closed') ORDER BY id DESC LIMIT 200",
  ).all();

  const now = new Date();
  const tz = body.tz || 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const speaker = decodeURIComponent(request.headers.get('x-user') || 'a household member');

  const settingsRows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('vocab','dictionary')").all();
  const glossary = aiGlossary(readDictionary(Object.fromEntries(settingsRows.results.map((r) => [r.key, r.value]))));

  const userMsg = `Today is ${weekday} ${today}.
Speaker: ${speaker}
${glossary ? `\nHousehold dictionary:\n${glossary}\n` : ''}
Existing open Do's (for duplicate detection):
${open.length ? open.map((t) => `#${t.id} ${t.title}`).join('\n') : '(none)'}

Transcript:
<transcript>
${text}
</transcript>`;

  let parsed;
  try {
    parsed = provider === 'gemini' ? await callGemini(env, userMsg) : await callClaude(env, userMsg);
  } catch (err) {
    if (err instanceof ParseError) return json({ error: err.message }, err.status);
    return json({ error: 'Could not reach the AI service.' }, 502);
  }

  // Defensive normalisation (schema guarantees shape; we still clamp values).
  const openIds = new Set(open.map((t) => t.id));
  const items = (parsed.items || []).map((it) => ({
    title: String(it.title || '').slice(0, 200),
    description: String(it.description || ''),
    steps: (it.steps || []).map(String).slice(0, 10),
    shopping: (it.shopping || []).map(String).slice(0, 20),
    priority: [1, 2, 3, 4].includes(it.priority) ? it.priority : 3,
    category: CATEGORIES.includes(it.category) ? it.category : 'general',
    location: String(it.location || '').slice(0, 120),
    estimate_min: SIZES.includes(it.estimate_min) ? it.estimate_min : 30,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(it.due_date) ? it.due_date : null,
    recur_days: Math.max(0, Math.min(3650, Number(it.recur_days) || 0)),
    duplicate_of: openIds.has(it.duplicate_of) ? it.duplicate_of : 0,
    source_quote: String(it.source_quote || ''),
  })).filter((it) => it.title);

  return json({
    provider,
    items,
    questions: (parsed.questions || []).map(String).slice(0, 5),
    not_tasks: (parsed.not_tasks || []).map(String).slice(0, 10),
  });
}
