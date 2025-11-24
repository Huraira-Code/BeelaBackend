const User = require('../models/userModel');
const { generateToken } = require('../utils/generateToken');
const { sendEmail } = require('../utils/sendEmail');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');

// Initialize Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

exports.signup = async (req, res) => {
  const { fullname, email, password } = req.body;
  console.log("Incoming request body:", req.body);
  try {
    // Basic input validation for clearer messages
    if (!fullname || !email || !password) {
      return res.status(400).json({ message: 'Full name, email and password are required' });
    }
    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Please provide a valid email address' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    if (await User.findOne({ email })) return res.status(400).json({ message: 'Email already exists' });
    const user = await User.create({ fullname, email, password });
    const token = generateToken(user._id);
    res.status(201).json({ user: { id: user._id, fullname: user.fullname, email: user.email }, token });
  } catch (err) {
    console.error("Signup Error:", err);

    // Duplicate key error (unique email)
    if (err?.code === 11000) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Mongoose validation errors
    if (err?.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ message: messages[0] || 'Invalid input' });
    }

    res.status(500).json({ message: 'Server error during signup' });
  }
};

// Get current user's profile
exports.getProfile = async (req, res) => {
  try {
    const user = req.user; // set by auth middleware
    if (!user) return res.status(401).json({ message: 'Not authenticated' });
    return res.status(200).json({ user: {
      id: user._id,
      fullname: user.fullname,
      email: user.email,
      phone: user.phone || ''
    }});
  } catch (e) {
    return res.status(500).json({ message: 'Failed to load profile' });
  }
};

// Update current user's profile
exports.updateProfile = async (req, res) => {
  try {
    const user = req.user; // set by auth middleware
    if (!user) return res.status(401).json({ message: 'Not authenticated' });

    const { fullname, phone, email } = req.body || {};

    if (typeof fullname === 'string' && fullname.trim().length) {
      user.fullname = fullname.trim();
    }
    if (typeof phone === 'string') user.phone = phone;
    // Optional email update with validation and uniqueness check
    if (typeof email === 'string' && email.trim().length && email !== user.email) {
      const emailRegex = /^\S+@\S+\.\S+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address' });
      }
      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists && String(exists._id) !== String(user._id)) {
        return res.status(400).json({ message: 'Email already in use' });
      }
      user.email = email.toLowerCase();
    }
    // gender/dateOfBirth/occupation removed

    await user.save();
    return res.status(200).json({ user: {
      id: user._id,
      fullname: user.fullname,
      email: user.email,
      phone: user.phone || ''
    }});
  } catch (e) {
    return res.status(500).json({ message: 'Failed to update profile' });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  
  try {
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // 1. Check if user exists
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // 2. Check if password is correct
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // 3. Generate token (long-lived)
    const token = generateToken(user._id);
    
    // 4. Remove password from output
    user.password = undefined;
    
    res.status(200).json({
      status: 'success',
      token,
      user: {
        id: user._id,
        fullname: user.fullname,
        email: user.email
      }
    });
    
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ 
      status: 'error',
      message: 'An error occurred during login'
    });
  }
};

exports.logout = (req, res) => {
  // For JWT, logout is handled on client by deleting token.
  res.json({ message: 'Logged out successfully' });
};

// LEGACY link-based forgot-password (kept for compatibility if needed)
exports.forgotPasswordLegacy = async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(200).json({ status: 'success', message: 'OTP sent if email exists.' });
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();
    const resetUrl = `${process.env.CLIENT_URL}/reset-password/${token}`;
    await sendEmail(
      user.email,
      'Password Reset',
      `<p>Click <a href="${resetUrl}">here</a> to reset your password. This link expires in 1 hour.</p>`
    );
    res.json({ status: 'success', message: 'Password reset email sent' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.resetPasswordLegacy = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  try {
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    res.json({ status: 'success', message: 'Password reset successful' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// OTP-based Forgot Password: send OTP
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const user = await User.findOne({ email }).select('+resetOtpHash +resetOtpExpiry +resetOtpVerified');
    // Always respond with generic message
    if (!user) {
      return res.status(200).json({ status: 'success', message: 'OTP sent if email exists.' });
    }

    // Generate 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);

    user.resetOtpHash = otpHash;
    user.resetOtpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    user.resetOtpVerified = false;
    await user.save();

    // Send OTP via email
    const html = `<p>Your Beela password reset OTP is: <b>${otp}</b></p><p>This code will expire in 5 minutes.</p>`;
    try { await sendEmail(email, 'Your OTP Code', html); } catch (e) { /* avoid leaking email existence */ }

    return res.status(200).json({ status: 'success', message: 'OTP sent if email exists.' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Server error', error: err.message });
  }
};

// Verify OTP
exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });
    const user = await User.findOne({ email }).select('+resetOtpHash +resetOtpExpiry +resetOtpVerified');
    if (!user || !user.resetOtpHash || !user.resetOtpExpiry) {
      return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
    }
    if (user.resetOtpExpiry.getTime() < Date.now()) {
      return res.status(400).json({ status: 'error', message: 'OTP expired' });
    }
    const ok = await bcrypt.compare(String(otp), user.resetOtpHash);
    if (!ok) return res.status(400).json({ status: 'error', message: 'Invalid OTP' });
    user.resetOtpVerified = true;
    await user.save();
    return res.status(200).json({ status: 'success', message: 'OTP verified successfully.' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Server error', error: err.message });
  }
};

// Reset password after OTP verification
exports.resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body || {};
    if (!email || !newPassword) return res.status(400).json({ message: 'Email and newPassword are required' });
    const user = await User.findOne({ email }).select('+resetOtpHash +resetOtpExpiry +resetOtpVerified +password');
    if (!user) return res.status(400).json({ status: 'error', message: 'Invalid request' });
    if (!user.resetOtpVerified || !user.resetOtpExpiry || user.resetOtpExpiry.getTime() < Date.now()) {
      return res.status(400).json({ status: 'error', message: 'OTP not verified or expired' });
    }
    // Set new password (pre-save hook will hash and set passwordChangedAt)
    user.password = newPassword;
    // Clear OTP fields
    user.resetOtpHash = undefined;
    user.resetOtpExpiry = undefined;
    user.resetOtpVerified = false;
    await user.save();
    return res.status(200).json({ status: 'success', message: 'Password updated successfully.' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Server error', error: err.message });
  }
};

// Change password for logged-in users
exports.changePassword = async (req, res) => {
  try {
    const userId = req.user?._id;
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'currentPassword and newPassword are required' });
    const user = await User.findById(userId).select('+password');
    if (!user) return res.status(401).json({ message: 'Not authenticated' });
    const isMatch = await bcrypt.compare(String(currentPassword), user.password);
    if (!isMatch) return res.status(400).json({ status: 'error', message: 'Current password incorrect.' });
    user.password = newPassword; // pre-save hook hashes and sets passwordChangedAt
    await user.save();
    return res.status(200).json({ status: 'success', message: 'Password updated successfully.' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Server error', error: err.message });
  }
};

// Google authentication
exports.googleAuth = async (req, res) => {
  try {
    const { accessToken } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({ message: 'Google access token is required' });
    }

    // Verify the Google ID token (sent from frontend)
    const ticket = await googleClient.verifyIdToken({
      idToken: accessToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name, picture } = payload;

    if (!email) {
      return res.status(400).json({ message: 'Could not get email from Google' });
    }

    // Check if user exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create new user if doesn't exist
      user = await User.create({
        email,
        fullname: name,
        password: crypto.randomBytes(16).toString('hex'), // Random password
        profilePicture: picture
      });
    }

    // Generate JWT token (long-lived)
    const token = generateToken(user._id);

    // Return user data and token
    res.status(200).json({
      status: 'success',
      token,
      user: {
        id: user._id,
        fullname: user.fullname,
        email: user.email,
        profilePicture: user.profilePicture
      }
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Error authenticating with Google'
    });
  }
};