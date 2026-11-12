// POST /api/parse { text, tz } -> proposed Do's from a spoken/typed brain dump (lib/extract.js).
// Nothing is saved here: the app shows proposals for review, then creates the ones kept.

import { extractDos } from '../../lib/extract.js';
import { AIError } from '../../lib/ai.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ request, env, data }) {
  if (!data.user?.household_id) return json({ error: 'Link your accounts first.' }, 403);
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return json({ error: 'Nothing to parse' }, 400);
  if (text.length > 20000) return json({ error: 'That is a lot! Please split it into smaller chunks.' }, 400);
  try {
    return json(await extractDos(env, env.DB, data.user, text, { source: 'voice', tz: body.tz || 'UTC' }));
  } catch (err) {
    if (err instanceof AIError) return json({ error: err.message }, err.status);
    return json({ error: 'Could not reach the AI service.' }, 502);
  }
}
