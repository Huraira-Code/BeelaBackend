const express = require('express');
const calendarController = require('../controllers/calendarController');
const { auth } = require('../middleware/authMiddleware');

const router = express.Router();

// Google Calendar OAuth flow
router.get('/auth/calendar', auth, calendarController.getAuthUrl);

// Handle both callback URLs for backward compatibility
// These endpoints don't use auth middleware because we'll authenticate using the state parameter
router.get('/auth/calendar/callback', calendarController.handleCallback);
router.get('/auth/google/callback', calendarController.handleCallback);

// Calendar operations
router.get('/calendar/sync', auth, calendarController.syncCalendar);
router.get('/calendar/events', auth, calendarController.getCalendarEvents);
router.get('/calendar/items', auth, calendarController.getCalendarItems);

module.exports = router;
