const Notification = require('../models/notificationModel');

// Create a notification (server-side generation or manual)
exports.createNotification = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id || req.body.userId;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    const doc = await Notification.create({
      userId,
      type: req.body.type || 'reminder',
      message: req.body.message,
      isRead: !!req.body.isRead,
      reminderId: req.body.reminderId || null,
    });
    return res.status(201).json({ success: true, data: doc });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// List notifications for current user
exports.listNotifications = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments({ userId }),
    ]);
    return res.json({ success: true, data: items, total, page, limit });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// Mark single notification as read
exports.markRead = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { id } = req.params;
    const doc = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { $set: { isRead: true } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true, data: doc });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// Mark all notifications as read
exports.markAllRead = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    await Notification.updateMany({ userId, isRead: { $ne: true } }, { $set: { isRead: true } });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};
