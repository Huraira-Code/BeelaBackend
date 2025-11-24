const Reminder = require('../models/reminderModel');
const Calendar = require('../models/calendarModel');

let GoogleGenerativeAI = null;
try {
  // CommonJS require of a package that exports named class
  const mod = require('@google/generative-ai');
  GoogleGenerativeAI = mod?.GoogleGenerativeAI || null;
  if (!GoogleGenerativeAI) {
    console.warn('[gemini] SDK loaded but GoogleGenerativeAI export missing');
  }
} catch (e) {
  console.warn('[gemini] SDK load failed:', e?.message);
}

function getModel() {
  if (!GoogleGenerativeAI) {
    console.warn('[gemini] SDK not installed/loaded');
    throw new Error('Gemini SDK not installed');
  }
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[gemini] Missing GOOGLE_GEMINI_API_KEY');
    throw new Error('GOOGLE_GEMINI_API_KEY not configured');
  }
  const client = new GoogleGenerativeAI(apiKey);
  return client.getGenerativeModel({ model: 'gemini-2.5-flash' });
}

// Build Column A: future tasks/meetings within 7 days
async function buildColumnA({ userId, now = new Date() }) {
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const reminders = await Reminder.find({
    user: userId,
    type: { $in: ['Task', 'Meeting'] },
    startDate: { $gt: now, $lte: horizon },
  })
    .select('type title startDate')
    .sort({ startDate: 1 })
    .lean();

  let events = [];
  try {
    const cal = await Calendar.findOne({ user: userId }).select('events').lean();
    if (cal?.events?.length) {
      events = cal.events
        .filter(ev => ev?.start?.dateTime && new Date(ev.start.dateTime) > now && new Date(ev.start.dateTime) <= horizon)
        .map(ev => ({ type: 'Meeting', title: ev.summary || 'Event', startDate: ev.start.dateTime }));
    }
  } catch {}

  return [...reminders, ...events].map(x => ({
    type: x.type,
    title: x.title || 'Item',
    startISO: new Date(x.startDate).toISOString(),
  }));
}

// Ask Gemini to fully determine the schedule for an unscheduled task/meeting
// item: { type: 'Task'|'Meeting', title: string, description?: string }
// Returns: { startDateISO, scheduleType: 'one-day'|'routine', scheduleDays: number[], scheduleTime: { minutesBeforeStart?: number, fixedTime?: string } } | null
async function suggestFullScheduleWithGemini({ userId, now = new Date(), item = {} }) {
  const colA = await buildColumnA({ userId, now });
  const model = getModel();
  const systemPrompt = `You are an expert scheduler. Given Column A (existing items with ISO UTC timestamps for next 7 days), the current time, and the NEW ITEM details, choose a smart schedule for the new item.

Decision heuristics:
- If the NEW ITEM's title suggests a recurring habit or routine (e.g., pray, namaz, prayer, workout, gym, run, walk, meditation, study, read, take medicine, hydrate/water plants, journal), prefer scheduleType "routine" with a fixedTime (HH:mm, 24h) during typical waking hours (06:00–22:00). For daily routines, scheduleDays should be an empty array [].
- If the item seems one-off, choose scheduleType "one-day" and propose a future startDateISO within 7 days.
- If it seems recurring but not daily, choose specific scheduleDays (0=Sun..6=Sat) and a fixedTime.
- Ensure the startDateISO is in the future within the next 7 days if scheduleType is one-day.
- Avoid conflicts with Column A and leave at least 30 minutes buffer.
- Output ONLY strict JSON with the following exact shape and no extra text:
{"startDateISO":"YYYY-MM-DDTHH:MM:SSZ or null for routine","scheduleType":"one-day|routine","scheduleDays":[ints 0-6],"scheduleTime":{"minutesBeforeStart":int or null,"fixedTime":"HH:MM" or null}}
If no acceptable schedule within the next 7 days is possible for one-day, select routine with an appropriate fixed time. If absolutely no suggestion is possible, output {"startDateISO":null,"scheduleType":"one-day","scheduleDays":[],"scheduleTime":{"minutesBeforeStart":null,"fixedTime":null}}`;

  const userContent = `Column A:\n${JSON.stringify(colA, null, 2)}\nNow (UTC): ${now.toISOString()}\nNEW ITEM:\n${JSON.stringify({ type: item.type, title: item.title, description: item.description || '' }, null, 2)}`;

  let raw = '';
  try {
    const result = await model.generateContent([{ text: systemPrompt }, { text: userContent }]);
    raw = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    console.warn('[gemini] generate schedule failed:', e?.message);
    throw e;
  }
  const text = String(raw).trim();
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    // Try to extract JSON block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch {}
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('Gemini returned non-JSON schedule');

  const schedule = {
    startDateISO: obj.startDateISO || null,
    scheduleType: obj.scheduleType === 'routine' ? 'routine' : 'one-day',
    scheduleDays: Array.isArray(obj.scheduleDays) ? obj.scheduleDays.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [],
    scheduleTime: {
      minutesBeforeStart: (obj.scheduleTime && typeof obj.scheduleTime.minutesBeforeStart === 'number') ? obj.scheduleTime.minutesBeforeStart : null,
      fixedTime: (obj.scheduleTime && typeof obj.scheduleTime.fixedTime === 'string') ? obj.scheduleTime.fixedTime : null,
    }
  };

  // Basic validity checks
  if (schedule.scheduleType === 'one-day') {
    if (!schedule.startDateISO) return null; // invalid
    const d = new Date(schedule.startDateISO);
    if (isNaN(d.getTime()) || d <= now) return null;
  } else if (schedule.scheduleType === 'routine') {
    if (!schedule.scheduleTime.fixedTime) return null;
    // days can be empty meaning daily
  }
  return schedule;
}

async function generateNotificationLineWithGemini({ reminder, user }) {
  const model = getModel();
  const name = (user?.fullname || '').split(' ')[0] || 'there';
  const type = reminder.type;
  const title = reminder.title || '';
  const systemPrompt = `Write a single, friendly notification line addressed to the user by first name. Keep it under 140 characters. Include the task/meeting title concisely. Do NOT include any date or time or countdown. Return plain text only.`;
  const userContent = `User first name: ${name}\nType: ${type}\nTitle: ${title}`;

  let lineRaw = '';
  try {
    const result = await model.generateContent([{ text: systemPrompt }, { text: userContent }]);
    lineRaw = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    console.warn('[gemini] generate line failed:', e?.message);
    throw e;
  }
  const oneLine = String(lineRaw).trim().replace(/\s+/g, ' ');
  return oneLine.split('\n')[0];
}

module.exports = {
  suggestFullScheduleWithGemini,
  generateNotificationLineWithGemini,
};
