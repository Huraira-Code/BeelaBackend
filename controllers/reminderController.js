const Reminder = require('../models/reminderModel');
const { ensureReminderTTS } = require('../utils/ttsService');

// Lazily require to avoid circular dependencies on startup
let ai;
try { ai = require('../services/aiScheduler'); } catch {}

// Helper: sanitize update payload to only allow known fields
function pickReminderFields(src = {}) {
  const out = {};
  const allowed = [
    'type',
    'title',
    'description',
    'icon',
    'startDate',
    'location',
    // Location-based fields
    'day',
    'status',
    'lastTriggeredAt',
    'triggeredLocation',
    'isCompleted',
    // New scheduling fields
    'isManualSchedule',
    'scheduleType',
    'scheduleTime',
    'scheduleDays',
    'notificationPreferenceMinutes',
  ];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

// Create a new reminder
exports.createReminder = async (req, res) => {
  try {
    const user = req.user; // from auth middleware
    const {
      type,
      title,
      description,
      icon,
      startDate,
      location,
      day,
      status,
      isManualSchedule,
      scheduleType,
      scheduleTime,
      scheduleDays,
      notificationPreferenceMinutes,
    } = req.body || {};

    const payload = {
      user: user._id || user.id || user,
      type,
      title,
      description,
      icon,
      startDate: startDate ? new Date(startDate) : undefined,
      location,
      day,
      status,
      isManualSchedule: !!isManualSchedule,
      scheduleType,
      scheduleTime,
      scheduleDays,
      notificationPreferenceMinutes: typeof notificationPreferenceMinutes === 'number' ? notificationPreferenceMinutes : 10,
    };


    // Enforce Meeting flow: manual-only with required startDate and per-item minutes
    if (payload.type === 'Meeting') {
      if (!payload.startDate) {
        return res.status(400).json({ success: false, message: 'Start date is required for meetings' });
      }
      payload.isManualSchedule = true;
      payload.scheduleType = 'one-day';
      const pref = typeof notificationPreferenceMinutes === 'number' ? notificationPreferenceMinutes : (scheduleTime?.minutesBeforeStart ?? 10);
      payload.scheduleTime = { minutesBeforeStart: pref };
      payload.scheduleDays = [];
      payload.notificationPreferenceMinutes = pref;
    }

    // Persist
    const created = await Reminder.create(payload);
    const populatedReminder = await Reminder.findById(created._id).populate('user', 'fullname email');

    // If Meeting or manual one-day Task, synchronously generate aiNotificationLine so clients can use it immediately
    try {
      if (populatedReminder.type === 'Meeting' || (populatedReminder.type === 'Task' && populatedReminder.isManualSchedule && populatedReminder.scheduleType === 'one-day')) {
        if (ai?.generateNotificationLineWithGemini) {
          const line = await ai.generateNotificationLineWithGemini({ reminder: populatedReminder, user });
          if (line) {
            populatedReminder.aiNotificationLine = line;
            await populatedReminder.save();
          }
        }
      }
    } catch (e) {
      console.warn('[ai] meeting line generation failed', e?.message);
    }

    // Fire-and-forget TTS generation only when we already have a startDate
    try {
      if (populatedReminder.startDate) {
        await ensureReminderTTS(populatedReminder._id, { user });
      }
    } catch (e) {
      console.warn('[tts] generation failed on create', e?.message);
    }

    const useSync = process.env.USE_SYNC_AI === '1';
    if (useSync && ai?.processBackgroundAI) {
      console.log('[ai] USE_SYNC_AI enabled: processing AI synchronously on create');
      try {
        const { reminder: afterAI, meta } = await ai.processBackgroundAI(populatedReminder._id, { user });
        return res.status(201).json({ success: true, data: afterAI || populatedReminder, aiMeta: meta || null });
      } catch (e) {
        console.warn('[ai] sync AI failed on create; returning base reminder', e?.message);
        return res.status(201).json({ success: true, data: populatedReminder, aiMeta: { error: e?.message } });
      }
    } else {
      res.status(201).json({ success: true, data: populatedReminder });
      // Background AI processing (non-blocking)
      setImmediate(() => {
        try {
          if (ai?.processBackgroundAI) {
            ai.processBackgroundAI(populatedReminder._id, { user }).catch(err => console.warn('[ai] background failed', err?.message));
          }
        } catch (err) {
          console.warn('[ai] scheduler not available', err?.message);
        }
      });
    }
  } catch (error) {
    console.error('createReminder error', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create reminder' });
  }
};

// Get reminders with basic filters
exports.getReminders = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { type, completed, startDate: startDateQ, endDate: endDateQ, page = 1, limit = 50 } = req.query || {};

    const q = { user: userId };
    if (type) q.type = type;
    if (typeof completed !== 'undefined') q.isCompleted = completed === 'true' || completed === true;
    if (startDateQ || endDateQ) {
      q.startDate = {};
      if (startDateQ) q.startDate.$gte = new Date(startDateQ);
      if (endDateQ) q.startDate.$lte = new Date(endDateQ);
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    const [items, total] = await Promise.all([
      Reminder.find(q).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
      Reminder.countDocuments(q),
    ]);

    res.json({ success: true, data: items, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error('getReminders error', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch reminders' });
  }
};

// Get a single reminder by ID
exports.getReminder = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { id } = req.params;
    const reminder = await Reminder.findOne({ _id: id, user: userId });
    if (!reminder) {
      return res.status(404).json({ success: false, message: 'Reminder not found' });
    }
    return res.json({ success: true, data: reminder });
  } catch (error) {
    console.error('getReminder error', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch reminder' });
  }
};

// Update a reminder
exports.updateReminder = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { id } = req.params;
    const updates = pickReminderFields(req.body || {});

    // Coerce startDate when provided
    if (Object.prototype.hasOwnProperty.call(updates, 'startDate')) {
      updates.startDate = updates.startDate ? new Date(updates.startDate) : null;
    }

    // Apply update, ensuring ownership
    const updated = await Reminder.findOneAndUpdate(
      { _id: id, user: userId },
      { $set: updates },
      { new: true }
    ).populate('user', 'fullname email');

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Reminder not found' });
    }

    // Fire-and-forget TTS generation only when we have a startDate
    try {
      if (updated.startDate) {
        await ensureReminderTTS(updated._id, { user: updated.user });
      }
    } catch (e) {
      console.warn('[tts] generation failed on update', e?.message);
    }

    const useSync = process.env.USE_SYNC_AI === '1';
    if (useSync && ai?.processBackgroundAI) {
      console.log('[ai] USE_SYNC_AI enabled: processing AI synchronously on update');
      try {
        const { reminder: afterAI, meta } = await ai.processBackgroundAI(updated._id, { user: updated.user });
        return res.status(200).json({ success: true, data: afterAI || updated, aiMeta: meta || null });
      } catch (e) {
        console.warn('[ai] sync AI failed on update; returning base reminder', e?.message);
        return res.status(200).json({ success: true, data: updated, aiMeta: { error: e?.message } });
      }
    } else {
      res.status(200).json({ success: true, data: updated });
      // Background AI processing (non-blocking)
      setImmediate(() => {
        try {
          if (ai?.processBackgroundAI) {
            ai.processBackgroundAI(updated._id, { user: updated.user }).catch(err => console.warn('[ai] background update failed', err?.message));
          }
        } catch (err) {
          console.warn('[ai] scheduler not available', err?.message);
        }
      });
    }
  } catch (error) {
    console.error('updateReminder error', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update reminder' });
  }
};

// Delete a reminder
exports.deleteReminder = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { id } = req.params;
    const removed = await Reminder.findOneAndDelete({ _id: id, user: userId });
    if (!removed) return res.status(404).json({ success: false, message: 'Reminder not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('deleteReminder error', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete reminder' });
  }
};

// Stream saved TTS audio
exports.getReminderTTS = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { id } = req.params;
    const reminder = await Reminder.findOne({ _id: id, user: userId }).select('tts title');
    if (!reminder) return res.status(404).json({ success: false, message: 'Reminder not found' });

    const audio = reminder.tts?.audio;
    if (!audio?.data || !audio?.contentType) {
      return res.status(404).json({ success: false, message: 'TTS not available' });
    }
    res.setHeader('Content-Type', audio.contentType || 'audio/mpeg');
    if (audio.size) res.setHeader('Content-Length', audio.size);
    return res.end(audio.data);
  } catch (error) {
    console.error('getReminderTTS error', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to stream TTS' });
  }
};

// Ensure TTS now
exports.ensureReminderTTSNow = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { id } = req.params;
    const reminder = await Reminder.findOne({ _id: id, user: userId });
    if (!reminder) return res.status(404).json({ success: false, message: 'Reminder not found' });

    const ensured = await ensureReminderTTS(reminder._id, { user: req.user });
    res.json({ success: true, tts: ensured?.tts || reminder.tts || {} });
  } catch (error) {
    console.error('ensureReminderTTSNow error', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to ensure TTS' });
  }
};

