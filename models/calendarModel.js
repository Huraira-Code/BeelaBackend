const mongoose = require('mongoose');

// ---------------- Event Schema ----------------
const eventSchema = new mongoose.Schema({
  googleEventId: {
    type: String,
    required: true
  },
  summary: {
    type: String,
    required: true
  },
  description: String,
  location: String,
  start: {
    dateTime: {
      type: Date,
      required: true
    },
    timeZone: String
  },
  end: {
    dateTime: {
      type: Date,
      required: true
    },
    timeZone: String
  },
  status: {
    type: String,
    enum: ['confirmed', 'tentative', 'cancelled'],
    default: 'confirmed'
  },
  htmlLink: String,
  created: {
    type: Date,
    default: Date.now
  },
  updated: {
    type: Date,
    default: Date.now
  }
});

// ---------------- Task Schema ----------------
const taskSchema = new mongoose.Schema({
  googleTaskId: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: String,
  due: {
    type: Date
  },
  status: {
    type: String,
    enum: ['needsAction', 'completed'],
    default: 'needsAction'
  },
  updated: {
    type: Date,
    default: Date.now
  },
  completedAt: Date,
  taskListId: String // Which Google Tasklist this belongs to
});

// ---------------- Calendar Schema ----------------
const calendarSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  accessToken: {
    type: String,
    required: true
  },
  refreshToken: {
    type: String,
    required: true
  },
  tokenExpiry: {
    type: Date,
    required: true
  },
  events: [eventSchema],
  tasks: [taskSchema], // <-- Added tasks storage
  lastSynced: Date
}, {
  timestamps: true
});

// ---------------- Indexes ----------------
calendarSchema.index({ user: 1 });
calendarSchema.index({ 'events.googleEventId': 1 });
calendarSchema.index({ 'tasks.googleTaskId': 1 });

const Calendar = mongoose.model('Calendar', calendarSchema);

module.exports = Calendar;
