const { validationResult } = require('express-validator');

/**
 * Middleware to validate request data against validation rules
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (errors.isEmpty()) {
    return next();
  }

  // Extract error messages
  const extractedErrors = [];
  errors.array().map(err => {
    // Defensive checks: err.param may be undefined
    const param = typeof err.param === 'string' ? err.param : '';
    // Handle nested errors (e.g., location.name)
    const field = param && param.includes('.')
      ? param.split('.')[1]
      : (param || 'field');

    extractedErrors.push({
      field,
      message: err.msg || 'Invalid value'
    });
  });

  return res.status(422).json({
    success: false,
    errors: extractedErrors
  });
};

module.exports = validate;
