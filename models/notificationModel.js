const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['task', 'meeting', 'location', 'reminder'], default: 'reminder' },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false, index: true },
    reminderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reminder' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
