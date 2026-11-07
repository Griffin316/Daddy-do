// Household dictionary: shared by settings, Whisper transcription and Claude parsing.
//
// Entry shapes (stored as JSON in settings.dictionary):
//   { kind: 'word',   text: 'Dr. Saan', heard: ['doctor sand', 'doctor son'], means: "Emma's pediatrician, 555-0134" }
//   { kind: 'phrase', text: 'the usual', heard: [],                          means: 'mow the lawn and take the bins to the curb' }
//
// - word.text     -> exact spelling (fed to Whisper's prompt and to Claude)
// - word.heard    -> phrases speech-to-text produces by mistake; replaced in the transcript
// - word.means    -> optional note (who/what it is, phone number) that Claude can put in the ticket
// - phrase.text   -> shorthand/expression the household says
// - phrase.means  -> what it actually means; Claude expands it into real tasks

export const MAX_ENTRIES = 200;

export function cleanDictionary(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const e of input) {
    const kind = e?.kind === 'phrase' ? 'phrase' : 'word';
    const text = String(e?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) continue;
    const heard = (Array.isArray(e.heard) ? e.heard : String(e.heard || '').split(','))
      .map((h) => String(h).replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter((h) => h && h.toLowerCase() !== text.toLowerCase())
      .slice(0, 8);
    const means = String(e.means || '').trim().slice(0, 300);
    if (kind === 'phrase' && !means) continue;
    out.push({ kind, text, heard: kind === 'word' ? heard : [], means });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// Older installs stored a comma-separated "vocab" string; treat each as a word entry.
export function readDictionary(settings) {
  if (settings.dictionary) {
    try { return cleanDictionary(JSON.parse(settings.dictionary)); } catch { /* fall through */ }
  }
  if (settings.vocab) {
    return cleanDictionary(settings.vocab.split(',').map((t) => ({ kind: 'word', text: t })));
  }
  return [];
}

// Text for Whisper's initial_prompt: correct spellings and the household's phrases,
// so the decoder is primed to produce them.
export function whisperTerms(dict) {
  const words = dict.filter((e) => e.kind === 'word').map((e) => e.text);
  const phrases = dict.filter((e) => e.kind === 'phrase').map((e) => e.text);
  return [...words, ...phrases].join(', ');
}

// Glossary block for Claude's parsing prompt.
export function claudeGlossary(dict) {
  if (!dict.length) return '';
  const lines = dict.map((e) => {
    if (e.kind === 'phrase') return `- "${e.text}" means: ${e.means}`;
    let l = `- ${e.text}`;
    if (e.heard.length) l += ` (speech-to-text may write it as: ${e.heard.map((h) => `"${h}"`).join(', ')})`;
    if (e.means) l += ` — ${e.means}`;
    return l;
  });
  return lines.join('\n');
}
