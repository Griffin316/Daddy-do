// POST /api/parse { text } -> proposed tickets extracted from a spoken/typed brain dump.
// Uses Claude with structured outputs so the response is always valid JSON in our schema.
// Needs the ANTHROPIC_API_KEY secret. Nothing is saved here — the client shows the
// proposals for review and then creates the ones the user keeps via POST /api/tickets.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
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
Never invent requests that weren't said.`;

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Voice parsing is not set up: add the ANTHROPIC_API_KEY secret.' }, 503);
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

  const userMsg = `Today is ${weekday} ${today}.
Speaker: ${speaker}

Existing open tickets (for duplicate detection):
${open.length ? open.map((t) => `#${t.id} ${t.title}`).join('\n') : '(none)'}

Transcript:
<transcript>
${text}
</transcript>`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
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
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'AI is busy — try again in a minute.' }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'ANTHROPIC_API_KEY is invalid.' }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `AI error (${err.status}): ${err.message}` }, 502);
    return json({ error: 'Could not reach the AI service.' }, 502);
  }

  if (response.stop_reason === 'refusal') {
    return json({ error: "The AI couldn't process that request. Try rephrasing." }, 422);
  }
  if (response.stop_reason === 'max_tokens') {
    return json({ error: 'That was too long to process at once — split it up.' }, 422);
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || '');
  } catch {
    return json({ error: 'AI returned an unreadable answer — try again.' }, 502);
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
    items,
    questions: (parsed.questions || []).map(String).slice(0, 5),
    not_tasks: (parsed.not_tasks || []).map(String).slice(0, 10),
  });
}
