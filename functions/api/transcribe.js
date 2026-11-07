// POST /api/transcribe  (body: raw recorded audio, e.g. audio/webm or audio/mp4)
// -> { text }. Uses Cloudflare Workers AI Whisper via the "AI" binding.
// Used when the browser has no built-in speech recognition (e.g. iOS home-screen apps, Firefox).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const MAX_BYTES = 15 * 1024 * 1024; // ~10+ minutes of compressed speech

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: 'Server transcription is not set up (missing Workers AI binding "AI").' }, 503);
  const audio = await request.arrayBuffer();
  if (!audio.byteLength) return json({ error: 'No audio received' }, 400);
  if (audio.byteLength > MAX_BYTES) return json({ error: 'Recording too long — keep it under ~10 minutes.' }, 413);

  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toBase64(audio),
      task: 'transcribe',
      language: 'en',
      vad_filter: true,
    });
    return json({ text: String(out?.text || '').trim() });
  } catch (err) {
    return json({ error: 'Transcription failed: ' + (err.message || 'unknown error') }, 502);
  }
}
