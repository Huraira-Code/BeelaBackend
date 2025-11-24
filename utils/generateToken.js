const jwt = require('jsonwebtoken');

/**
 * Generate JWT token for user authentication
 * @param {string} userId - The user's ID
 * @returns {string} JWT token
 */
exports.generateToken = (userId) => {
  // Long-lived token so user stays logged in until explicit logout or uninstall
  const expiresIn = '365d';
  
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};