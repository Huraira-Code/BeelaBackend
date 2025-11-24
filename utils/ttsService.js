const axios = require('axios');
const crypto = require('crypto');
const Reminder = require('../models/reminderModel');

function buildNotificationText(reminder, user, fixedMinutes = null) {
  // Always prefer AI line when present for voice parity with text
  if (reminder.aiNotificationLine) {
    return reminder.aiNotificationLine;
  }

  const name = user?.fullname?.split(' ')[0] || 'there';
  if (reminder.type === 'Task') {
    return `Hey ${name}, reminder: ${reminder.title}.`;
  }
  if (reminder.type === 'Meeting') {
    return `Hey ${name}, reminder for meeting: ${reminder.title}.`;
  }
  if (reminder.type === 'Location') {
    const loc = reminder.location?.name || 'your saved place';
    return `Hey ${name}, you are near ${loc}.`;
  }
  return `Hey ${name}, you have a reminder: ${reminder.title}.`;
}

function computeTextHash(text, voiceId) {
  return crypto.createHash('sha256').update(`${voiceId}::${text}`).digest('hex');
}

async function generateElevenLabsAudio({ text, voiceId, modelId, format = 'mp3_44100_128' }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
  const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const vid = voiceId || DEFAULT_VOICE_ID;
  if (!vid) throw new Error('Voice ID not provided or ELEVENLABS_DEFAULT_VOICE_ID missing');

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;
  const payload = {
    text,
    model_id: modelId || 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.3,
      use_speaker_boost: true
    },
    // Output format defined by accept header for newer API; some SDKs take "output_format"
  };

  const resp = await axios.post(url, payload, {
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    responseType: 'arraybuffer',
    timeout: 20000
  });

  return {
    buffer: Buffer.from(resp.data),
    contentType: 'audio/mpeg'
  };
}

async function ensureReminderTTS(reminderId, { user, overrideVoiceId, fixedMinutes } = {}) {
  const reminder = await Reminder.findById(reminderId).populate('user', 'fullname');
  if (!reminder) throw new Error('Reminder not found');
  const text = buildNotificationText(reminder, user || reminder.user, fixedMinutes);
  const voiceId = overrideVoiceId || reminder.tts?.voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const hash = computeTextHash(text, voiceId);

  // If already generated and hash matches, skip
  if (reminder.tts?.textHash === hash && reminder.tts?.status === 'ready' && reminder.tts?.audio?.data?.length) {
    return reminder;
  }

  // Mark pending
  reminder.tts = reminder.tts || {};
  reminder.tts.voiceId = voiceId;
  reminder.tts.textHash = hash;
  reminder.tts.status = 'pending';
  reminder.tts.generatedAt = null;
  await reminder.save();

  try {
    const { buffer, contentType } = await generateElevenLabsAudio({ text, voiceId });
    reminder.tts.audio = {
      data: buffer,
      contentType,
      size: buffer.length
    };
    reminder.tts.status = 'ready';
    reminder.tts.generatedAt = new Date();
    await reminder.save();
  } catch (e) {
    reminder.tts.status = 'failed';
    await reminder.save();
    try {
      // Axios with responseType arraybuffer -> decode to string for better logging
      const resp = e.response;
      if (resp && resp.data) {
        const buf = Buffer.from(resp.data);
        const txt = buf.toString('utf8');
        let parsed;
        try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
        console.error('[tts] ElevenLabs error', resp.status, parsed);
        const detail = parsed?.detail || parsed;
        const msg = typeof detail === 'object' ? (detail.message || JSON.stringify(detail)) : String(detail);
        const err = new Error(`TTS generation failed (${resp.status}): ${msg}`);
        err.code = 'TTS_ELEVENLABS_ERROR';
        throw err;
      }
    } catch (inner) {
      // fallthrough
    }
    throw e;
  }

  return reminder;
}

module.exports = {
  buildNotificationText,
  computeTextHash,
  ensureReminderTTS,
};
