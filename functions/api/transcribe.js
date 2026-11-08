// POST /api/transcribe  (body: one chunk of recorded audio, ideally 16 kHz mono WAV)
// -> { text }. Cloudflare Workers AI Whisper large-v3-turbo via the "AI" binding.
//
// Accuracy helpers:
//  - initial_prompt: household dictionary spellings and phrases (lib/dictionary.js) plus open
//    ticket titles, so Whisper spells "Moen cartridge" or "MERV filter" correctly.
//  - X-Context header: the tail of the previous chunk's transcript, so long recordings
//    split into chunks keep continuity (same trick Whisper uses internally).
//  - vad_filter: skip silence, which is where Whisper tends to hallucinate.

import { readDictionary, whisperTerms } from '../../lib/dictionary.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const MAX_BYTES = 12 * 1024 * 1024; // one chunk; the client splits long recordings
const PROMPT_CHARS = 900;           // Whisper only reads ~224 tokens of prompt

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function buildPrompt(db, hh, previous) {
  const parts = ['A family member listing household chores and repairs.'];
  try {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE household_id = ? AND key IN ('vocab','dictionary')").bind(hh).all();
    const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
    const people = await db.prepare('SELECT name FROM users WHERE household_id = ?').bind(hh).all();
    const names = people.results.map((m) => m.name).filter(Boolean);
    if (names.length) parts.push(`People: ${names.join(', ')}.`);
    const terms = whisperTerms(readDictionary(s));
    if (terms) parts.push(`Words we use: ${terms}.`);
    const open = await db.prepare(
      "SELECT title FROM tickets WHERE household_id = ? AND status NOT IN ('resolved','closed') ORDER BY updated_at DESC LIMIT 12",
    ).bind(hh).all();
    if (open.results.length) parts.push(`Current jobs: ${open.results.map((t) => t.title).join('; ')}.`);
  } catch { /* prompt is best-effort */ }
  let prompt = parts.join(' ');
  // The previous chunk's words matter most for continuity, so they go last and are never cut.
  const tail = previous ? ' ' + previous.slice(-400) : '';
  prompt = prompt.slice(0, Math.max(0, PROMPT_CHARS - tail.length)) + tail;
  return prompt.trim();
}

export async function onRequestPost({ request, env, data }) {
  if (!env.AI) return json({ error: 'Server transcription is not set up (missing Workers AI binding "AI").' }, 503);
  const audio = await request.arrayBuffer();
  if (!audio.byteLength) return json({ error: 'No audio received' }, 400);
  if (audio.byteLength > MAX_BYTES) return json({ error: 'Audio chunk too large — the app should split recordings.' }, 413);

  let previous = '';
  try { previous = decodeURIComponent(request.headers.get('x-context') || ''); } catch { previous = ''; }
  const language = (request.headers.get('x-language') || 'en').slice(0, 5);

  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toBase64(audio),
      task: 'transcribe',
      language,
      vad_filter: true,
      beam_size: 5,
      initial_prompt: await buildPrompt(env.DB, data.user.household_id, previous),
      // Chunks carry context via the prompt; this stops repetition loops inside a chunk.
      condition_on_previous_text: false,
      hallucination_silence_threshold: 2,
    });
    return json({ text: String(out?.text || '').trim(), words: out?.word_count ?? null });
  } catch (err) {
    return json({ error: 'Transcription failed: ' + (err.message || 'unknown error') }, 502);
  }
}
