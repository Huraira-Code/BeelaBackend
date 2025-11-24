const express = require('express');
const router = express.Router();
const { body, query, param } = require('express-validator');
const reminderController = require('../controllers/reminderController');
const { auth } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

// Create a new reminder
router.post(
  '/',
  auth,
  [
    body('type')
      .isIn(['Task', 'Meeting', 'Location'])
      .withMessage('Type must be one of: Task, Meeting, Location'),
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('description').optional().trim(),
    body('icon').optional().trim(),
    body('startDate').optional().isISO8601().withMessage('Invalid start date'),
    body('location').optional().isObject().withMessage('Location must be an object'),
    body('location.name').optional().trim(),
    body('location.link').optional().isURL().withMessage('Invalid location URL'),
    // Location-based fields
    body('day').optional().isIn(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']).withMessage('Invalid day'),
    body('status').optional().isIn(['active','expired','completed']).withMessage('Invalid status'),

    // New scheduling fields
    body('isManualSchedule').optional().isBoolean().withMessage('isManualSchedule must be a boolean'),
    body('scheduleType').optional().isIn(['one-day', 'routine']).withMessage('scheduleType must be one-day or routine'),
    body('scheduleTime').optional().isObject().withMessage('scheduleTime must be an object'),
    body('scheduleTime.minutesBeforeStart').optional().isInt({ min: 0 }).withMessage('minutesBeforeStart must be >= 0'),
    body('scheduleTime.fixedTime').optional().matches(/^\d{2}:\d{2}$/).withMessage('fixedTime must be HH:mm'),
    body('scheduleDays').optional().isArray().withMessage('scheduleDays must be an array'),
    body('scheduleDays.*').optional().isInt({ min: 0, max: 6 }).withMessage('scheduleDays values must be 0-6'),
  ],
  validate,
  reminderController.createReminder
);

// Get all reminders for the authenticated user with optional filtering
router.get(
  '/',
  auth,
  [
    query('type')
        .optional()
        .isIn(['Task', 'Meeting', 'Location'])
        .withMessage('Type must be one of: Task, Meeting, Location'),
      query('completed')
        .optional()
        .isBoolean()
        .withMessage('Completed must be a boolean'),
      query('startDate')
        .optional()
        .isISO8601()
        .withMessage('Start date must be a valid date'),
      query('endDate')
        .optional()
        .isISO8601()
        .withMessage('End date must be a valid date'),
      query('page')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Page must be a positive integer'),
      query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be between 1 and 100'),
    ],
    validate,
    reminderController.getReminders
);

// Update a reminder
router.put(
  '/:id',
  auth,
  [
    body('type').optional().isIn(['Task', 'Meeting', 'Location']).withMessage('Invalid reminder type'),
    body('title').optional().trim().notEmpty().withMessage('Title cannot be empty'),
    body('description').optional().trim(),
    body('icon').optional().trim(),
    body('startDate').optional().isISO8601().withMessage('Invalid start date'),
    body('isCompleted').optional().isBoolean().withMessage('isCompleted must be a boolean'),
    body('location').optional().isObject().withMessage('Location must be an object'),
    body('location.name').optional().trim(),
    body('location.link').optional().isURL().withMessage('Invalid location URL'),
    // New scheduling fields
    body('isManualSchedule').optional().isBoolean(),
    body('scheduleType').optional().isIn(['one-day', 'routine']),
    body('scheduleTime').optional().isObject(),
    body('scheduleTime.minutesBeforeStart').optional().isInt({ min: 0 }),
    body('scheduleTime.fixedTime').optional().matches(/^\d{2}:\d{2}$/),
    body('scheduleDays').optional().isArray(),
    body('scheduleDays.*').optional().isInt({ min: 0, max: 6 }),
  ],
  validate,
  reminderController.updateReminder
);

// Get a single reminder by ID
router.get(
  '/:id',
  auth,
  [
    param('id')
      .isMongoId()
      .withMessage('Invalid reminder ID'),
  ],
  validate,
  reminderController.getReminder
);

// Delete a reminder
router.delete('/:id', auth, reminderController.deleteReminder);

// Stream saved TTS audio for a reminder
router.get(
  '/:id/tts',
  auth,
  [
    param('id').isMongoId().withMessage('Invalid reminder ID'),
  ],
  validate,
  reminderController.getReminderTTS
);

// Ensure/generate TTS now and return status + textHash
router.post(
  '/:id/tts/ensure',
  auth,
  [
    param('id').isMongoId().withMessage('Invalid reminder ID'),
  ],
  validate,
  reminderController.ensureReminderTTSNow
);

module.exports = router;
