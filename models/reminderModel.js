const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['Task', 'Meeting', 'Location'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: String,
  icon: {
    type: String,
    default: 'star'
  },
  // When provided, store as ISO Date (UTC). For Meeting, we no longer require end time; for Task, startDate
  // may be absent when unscheduled (Gemini to suggest later) or for routine tasks.
  startDate: {
    type: Date,
  },
  // Deprecated: endDate was previously used for Task/Meeting. Keep optional for backward compatibility
  // and for existing data reads; do not enforce validation.
  endDate: {
    type: Date,
  },
  // Location specific fields
  location: {
    name: String,
    link: String,
    coordinates: {
      lat: Number,
      lng: Number
    }
  },
  // Location-based reminder new fields
  day: { type: String, enum: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], default: undefined },
  status: { type: String, enum: ['active','expired','completed'], default: 'active' },
  lastTriggeredAt: { type: Date, default: null },
  triggeredLocation: {
    lat: { type: Number },
    lng: { type: Number },
    placeId: { type: String },
    name: { type: String },
    rating: { type: Number },
  },
  // New scheduling fields
  isManualSchedule: { type: Boolean, default: false },
  // one-day or routine (only applicable when isManualSchedule is true)
  scheduleType: { type: String, enum: ['one-day', 'routine'], default: undefined },
  // scheduleTime can be either minutesBeforeStart (for one-day) or fixedTime (for routine, as "HH:mm")
  scheduleTime: {
    minutesBeforeStart: { type: Number, min: 0 },
    fixedTime: { type: String }, // HH:mm 24h string
  },
  // For routine tasks: days of week as numbers 0(Sun)-6(Sat). Empty array means daily.
  scheduleDays: {
    type: [Number],
    validate: {
      validator: function(arr) {
        return Array.isArray(arr) && arr.every(n => Number.isInteger(n) && n >= 0 && n <= 6);
      },
      message: 'scheduleDays must be an array of integers between 0 and 6'
    },
    default: undefined
  },
  // Flags for AI suggested scheduling and human-friendly notification line
  aiSuggested: { type: Boolean, default: false },
  aiNotificationLine: { type: String },

  // Per-item notification preference in minutes (used for Meetings and one-day Tasks). Default 10.
  notificationPreferenceMinutes: { type: Number, default: 10, min: 0 },

  isCompleted: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  // TTS fields for dynamic voice notifications
  tts: {
    voiceId: { type: String },
    textHash: { type: String },
    audio: {
      data: Buffer,
      contentType: String,
      size: Number
    },
    status: {
      type: String,
      enum: ['pending', 'ready', 'failed'],
      default: 'pending'
    },
    generatedAt: { type: Date },
    lastTextVersion: { type: Number, default: 0 }
  }
}, { timestamps: true });

// Indexes for better query performance (future schedules within 7 days, by user)
reminderSchema.index({ user: 1, startDate: 1 });
reminderSchema.index({ user: 1, isManualSchedule: 1 });
// Indexes to query active location reminders and throttle triggers
reminderSchema.index({ user: 1, type: 1, status: 1 });
reminderSchema.index({ user: 1, lastTriggeredAt: 1 });

module.exports = mongoose.model('Reminder', reminderSchema);
