const AppError = require('../utils/appError');

const errorHandler = (err, req, res, next) => {
  console.error(err.stack || err);
  
  // Handle validation errors
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(val => val.message);
    return res.status(400).json({
      success: false,
      message: messages[0] || 'Invalid input'
    });
  }
  
  // Handle duplicate key errors
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(400).json({
      success: false,
      message: `${field} already exists`
    });
  }
  
  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
  
  // Handle JWT expired error
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired'
    });
  }

  // Handle known operational errors with statusCode (AppError)
  if (err instanceof AppError || typeof err.statusCode === 'number') {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message || 'Error'
    });
  }
  
  // Default to 500 server error
  res.status(500).json({
    success: false,
    message: 'Server Error'
  });
};

module.exports = { errorHandler };
