/**
 * index.js
 * Simple Express proxy for:
 *  - POST /api/gemini   -> forwards prompt/history to your Gemini endpoint (configure GEMINI_API_URL)
 *  - GET  /api/serp?q=  -> proxies SerpAPI requests
 *  - POST /api/tts      -> calls ElevenLabs TTS and returns audio blob
 *
 * IMPORTANT:
 *  - Configure keys in .env (see .env.example)
 *  - This is a minimal example. Add authentication, rate-limiting, logging, HTTPS, CORS restrictions, and input validation for production.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
app.use(cors()); // in production restrict origin(s)
app.use(express.json({ limit: '1mb' })); // adjust as needed

const PORT = process.env.PORT || 3000;

/* ---------- Environment variables (set these in .env) ---------- */
/*
GEMINI_API_URL    - base URL for Gemini inference (e.g. your project's endpoint)
GEMINI_API_KEY    - API key/authorization token for Gemini endpoint (if required)
SERPAPI_KEY       - SerpAPI key (from serpapi.com)
ELEVEN_API_KEY    - ElevenLabs API key
ELEVEN_VOICE_ID   - ElevenLabs voice id to use (e.g. '21m00Tcm4TlvDq8ikWAM')
*/

const GEMINI_API_URL = process.env.GEMINI_API_URL || ''; // e.g. https://api.example.com/v1/gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || ''; // required for ElevenLabs TTS

/* ---------- Helpers ---------- */

function safeJson(res, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(obj));
}

/* ---------- /api/serp?q=... ---------- */
/* Simple SerpAPI forwarding. See serpapi docs for extra params. */
app.get('/api/serp', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });

  if (!SERPAPI_KEY) return res.status(500).json({ error: 'Server missing SERPAPI_KEY' });

  try {
    // Basic SerpAPI call (Google). You can adjust engine / parameters as desired.
    const serpUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(SERPAPI_KEY)}`;
    const r = await axios.get(serpUrl, { timeout: 15000 });
    return res.json(r.data);
  } catch (e) {
    console.error('SerpAPI error', e?.message || e);
    return res.status(500).json({ error: 'SerpAPI call failed', details: e?.message || String(e) });
  }
});

/* ---------- /api/gemini ---------- */
/**
 * Expects JSON body:
 *  { prompt: "...", history?: [ {role, content}, ... ], research?: {...} }
 *
 * You must set GEMINI_API_URL to the correct endpoint for your Gemini usage.
 * This implementation is intentionally generic: it POSTs JSON {prompt,history,research}
 * and expects a JSON response with { reply: "...", inferredEmotion?: "happy" }.
 *
 * Modify this function to match the exact Gemini API request/response formats you're using.
 */
app.post('/api/gemini', async (req, res) => {
  const { prompt, history, research } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
  if (!GEMINI_API_URL) return res.status(500).json({ error: 'Server not configured with GEMINI_API_URL' });

  try {
    // Build payload for Gemini provider — adjust fields to match the provider format.
    // This is a generic proxy: sends prompt + optional history/research.
    const payload = { prompt, history: history || [], research: research || null };

    const headers = {};
    if (GEMINI_API_KEY) headers['Authorization'] = `Bearer ${GEMINI_API_KEY}`;
    headers['Content-Type'] = 'application/json';

    const r = await axios.post(GEMINI_API_URL, payload, { headers, timeout: 30000 });

    // Expect provider to return JSON. We normalize to { reply, inferredEmotion? }
    const data = r.data || {};
    // If your Gemini returns the assistant text in a different field, adjust the line below.
    // Example normalizations:
    const reply = data.reply || data.text || data.output || (typeof data === 'string' ? data : null);
    const inferredEmotion = data.inferredEmotion || data.emotion || null;

    return res.json({ reply: reply || 'No reply from Gemini', inferredEmotion });
  } catch (e) {
    console.error('Gemini proxy error', e?.response?.data || e?.message || e);
    const details = e?.response?.data || e?.message || String(e);
    return res.status(500).json({ error: 'Gemini proxy failed', details });
  }
});

/* ---------- /api/tts (ElevenLabs) ---------- */
/**
 * Body: { text: "..." }
 * Returns: audio/mpeg (stream)
 *
 * ElevenLabs TTS endpoint (as of examples):
 *  POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 *  Headers: xi-api-key: your_key
 *  Content-Type: application/json
 *  Body: { text: "...", voice_settings: {...} }
 *
 * We forward the binary audio to the client.
 */
app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing text in body' });
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return res.status(500).json({ error: 'ElevenLabs keys not configured' });

  try {
    // Build ElevenLabs payload. You can tweak voice_settings (stability, similarity_boost).
    const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}`;
    const body = {
      text,
      // optional voice settings — tweak to taste
      voice_settings: { stability: 0.6, similarity_boost: 0.75 }
    };
    const headers = {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg' // expecting audio
    };

    // Request as arraybuffer so we can forward raw audio data
    const r = await axios.post(elevenUrl, body, { headers, responseType: 'arraybuffer', timeout: 30000 });

    // Forward the audio with proper content-type
    const contentType = r.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.send(Buffer.from(r.data));
  } catch (e) {
    console.error('ElevenLabs TTS error', e?.response?.data || e?.message || e);
    // Try to return more helpful information
    const details = e?.response?.data || e?.message || String(e);
    return res.status(500).json({ error: 'TTS failed', details });
  }
});

/* ---------- Optional: health route ---------- */
app.get('/', (req, res) => {
  res.send('Luna proxy server running. Endpoints: /api/gemini, /api/serp, /api/tts');
});

app.listen(PORT, () => {
  console.log(`Proxy server listening on http://localhost:${PORT}`);
});
