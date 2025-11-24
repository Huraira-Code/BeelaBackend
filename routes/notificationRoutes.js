const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/authMiddleware');
const ctr = require('../controllers/notificationController');

// All routes protected
router.use(auth);

router.get('/', ctr.listNotifications);
router.post('/', ctr.createNotification);
router.post('/:id/mark-read', ctr.markRead);
router.post('/mark-all-read', ctr.markAllRead);

module.exports = router;
