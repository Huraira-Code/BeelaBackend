const Reminder = require('../models/reminderModel');
const { buildNotificationText, ensureReminderTTS } = require('../utils/ttsService');
let gemini;
try { gemini = require('./geminiService'); } catch (e) {
  console.warn('[ai] gemini service module failed to load; falling back if needed', e?.message);
}

// Heuristic fallback: find a free 60-minute slot within next 7 days (future-only)
async function findSmartSlot({ userId, now = new Date() }) {
  const startHour = 9;   // 9 AM
  const endHour = 18;    // 6 PM
  const oneHour = 60 * 60 * 1000;
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const existing = await Reminder.find({ user: userId, startDate: { $gte: now, $lte: horizon } })
    .select('startDate')
    .lean();
  const busy = new Set(existing.filter(e => e.startDate).map(e => new Date(e.startDate).toISOString()));

  for (let d = new Date(now.getTime() + oneHour); d <= horizon; d = new Date(d.getTime() + oneHour)) {
    const hour = d.getHours();
    if (hour < startHour || hour >= endHour) continue;
    const iso = d.toISOString();
    if (!busy.has(iso)) return new Date(iso);
  }
  return null;
}

// Background processing for a reminder: smart schedule + human-friendly line + TTS
async function processBackgroundAI(reminderId, { user }) {
  const rem = await Reminder.findById(reminderId).populate('user', 'fullname');
  if (!rem) return null;

  // Smart scheduling for Column B (unscheduled Tasks only; Meetings are manual-only)
  let scheduleSource = null;
  if (!rem.isManualSchedule && rem.type === 'Task' && !rem.startDate) {
    let schedule = null;
    scheduleSource = null;
    // 1) Try Gemini full schedule
    try {
      if (gemini?.suggestFullScheduleWithGemini) {
        schedule = await gemini.suggestFullScheduleWithGemini({
          userId: rem.user._id,
          now: new Date(),
          item: { type: rem.type, title: rem.title, description: rem.description || '' }
        });
        if (schedule) {
          scheduleSource = 'gemini';
          console.log('[ai] schedule source: gemini', {
            reminderId: String(rem._id),
            startDateISO: schedule.startDateISO,
            scheduleType: schedule.scheduleType,
          });
        }
      } else {
        console.warn('[ai] gemini service unavailable (no suggestFullScheduleWithGemini), using fallback');
      }
    } catch (e) {
      console.warn('[ai] gemini scheduling error; using fallback', e?.message);
    }
    // 2) Fallback heuristic
    if (!schedule) {
      const suggested = await findSmartSlot({ userId: rem.user._id, now: new Date() }).catch(() => null);
      if (suggested) {
        schedule = {
          startDateISO: suggested.toISOString(),
          scheduleType: 'one-day',
          scheduleDays: [],
          scheduleTime: { minutesBeforeStart: 10, fixedTime: null },
        };
        scheduleSource = 'fallback';
        console.warn('[ai] schedule source: fallback', {
          reminderId: String(rem._id),
          startDateISO: schedule.startDateISO,
          scheduleType: schedule.scheduleType,
        });
      }
    }

    if (schedule) {
      if (schedule.startDateISO) rem.startDate = new Date(schedule.startDateISO);
      rem.scheduleType = schedule.scheduleType || undefined;
      rem.scheduleDays = Array.isArray(schedule.scheduleDays) ? schedule.scheduleDays : undefined;
      rem.scheduleTime = schedule.scheduleTime || undefined;
      if (rem.scheduleType === 'one-day') {
        const pref = (schedule.scheduleTime && typeof schedule.scheduleTime.minutesBeforeStart === 'number') ? schedule.scheduleTime.minutesBeforeStart : 10;
        rem.notificationPreferenceMinutes = pref;
      }
      rem.aiSuggested = true;
      // final applied schedule log
      console.log('[ai] schedule applied', {
        reminderId: String(rem._id),
        source: scheduleSource || 'unknown',
        startDate: rem.startDate?.toISOString?.(),
        scheduleType: rem.scheduleType,
      });
    }
  }

  // Human-friendly notification line via Gemini, fallback to local builder
  let lineSource = null;
  try {
    if (gemini?.generateNotificationLineWithGemini) {
      const line = await gemini.generateNotificationLineWithGemini({ reminder: rem, user: user || rem.user });
      if (line) {
        rem.aiNotificationLine = line;
        lineSource = 'gemini';
        console.log('[ai] notification line source: gemini', { reminderId: String(rem._id) });
      }
    } else {
      console.warn('[ai] gemini service unavailable (no generateNotificationLineWithGemini), using fallback');
    }
  } catch (e) {
    console.warn('[ai] gemini notification error; using fallback', e?.message);
  }
  if (!rem.aiNotificationLine) {
    rem.aiNotificationLine = buildNotificationText(rem, user || rem.user);
    lineSource = lineSource || 'fallback';
    console.warn('[ai] notification line source: fallback', { reminderId: String(rem._id) });
  }

  await rem.save();

  if (rem.startDate) {
    try { await ensureReminderTTS(rem._id, { user: user || rem.user }); } catch {}
  }
  return { reminder: rem, meta: { scheduleSource: scheduleSource || null, lineSource: lineSource || null } };
}

module.exports = { findSmartSlot, processBackgroundAI };
