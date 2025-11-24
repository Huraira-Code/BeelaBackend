const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    required: true,
    enum: ['system', 'user', 'assistant']
  },
  content: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const conversationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  messages: [messageSchema],
  pendingAction: {
    type: {
      type: String,
      enum: ['create_task', 'schedule_meeting', 'create_location']
    },
    data: mongoose.Schema.Types.Mixed,
    confirmationNeeded: Boolean,
    missingFields: [String]
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt timestamp before saving
conversationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Add a method to get the last N messages
conversationSchema.methods.getLastMessages = function(limit = 10) {
  return this.messages
    .sort({ timestamp: -1 })
    .slice(0, limit)
    .reverse();
};

// Add a method to clear the conversation
conversationSchema.methods.clear = async function() {
  this.messages = [];
  return this.save();
};

// Add a method to add a message
conversationSchema.methods.addMessage = async function(role, content) {
  this.messages.push({ role, content });
  return this.save();
};

// Create a compound index for faster lookups
conversationSchema.index({ userId: 1, updatedAt: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = Conversation;
