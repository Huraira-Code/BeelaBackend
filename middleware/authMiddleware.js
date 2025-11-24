const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

exports.auth = async (req, res, next) => {
  let token;
  
  console.log('Auth middleware called for path:', req.path);
  console.log('Request headers:', JSON.stringify(req.headers, null, 2));
  
  // 1. Get token from header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
    console.log('Token found in Authorization header');
  } else {
    console.log('No Bearer token found in Authorization header');
  }

  // 2. Check if token exists
  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ 
      success: false,
      error: 'Authentication required',
      message: 'Please log in to access this resource' 
    });
  }

  try {
    console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
    
    // 3. Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Decoded token:', decoded);
    
    // 4. Check if user still exists
    const currentUser = await User.findById(decoded.id).select('-password');
    if (!currentUser) {
      console.log('User no longer exists');
      return res.status(401).json({
        success: false,
        error: 'User not found',
        message: 'The user belonging to this token no longer exists'
      });
    }
    
    // 5. Check if user changed password after the token was issued
    if (currentUser.changedPasswordAfter(decoded.iat)) {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        message: 'User recently changed password. Please log in again.'
      });
    }
    
    // 6. Grant access to protected route
    req.user = currentUser;
    res.locals.user = currentUser;
    console.log('User authenticated:', {
      id: currentUser._id,
      email: currentUser.email
    });
    
    next();
  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(401).json({ 
      status: 'error',
      message: 'Not authorized, token verification failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};