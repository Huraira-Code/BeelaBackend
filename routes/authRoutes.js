const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const calendarController = require('../controllers/calendarController');
const { auth } = require('../middleware/authMiddleware');
const { rateLimit } = require('../middleware/rateLimiter');

// Regular auth routes
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
// Legacy link-based reset (kept but not advertised)
router.post('/forgot-password-legacy', authController.forgotPasswordLegacy);
router.post('/reset-password/:token', authController.resetPasswordLegacy);

// OTP-based password reset
router.post('/forgot-password', rateLimit({ windowMs: 60 * 1000, max: 5, keyType: 'email' }), authController.forgotPassword);
router.post('/verify-otp', rateLimit({ windowMs: 60 * 1000, max: 10, keyType: 'email' }), authController.verifyOtp);
router.post('/reset-password', rateLimit({ windowMs: 60 * 1000, max: 5, keyType: 'email' }), authController.resetPassword);

// Change password (authenticated)
router.put('/change-password', auth, rateLimit({ windowMs: 60 * 1000, max: 5, keyType: 'user' }), authController.changePassword);

// Google auth route
router.post('/google', authController.googleAuth);

// Google Calendar OAuth callback (for backward compatibility and proper redirect)
router.get('/google/callback', calendarController.handleCallback);
router.get('/calendar/callback', calendarController.handleCallback);

// Profile routes
router.get('/profile', auth, authController.getProfile);
router.put('/profile', auth, authController.updateProfile);

module.exports = router;