// Simple per-key rate limiter (memory-based). For production, consider Redis.
const buckets = new Map();

function makeKey(req, keyType = 'ip') {
  if (keyType === 'user' && req.user?._id) return `user:${req.user._id}`;
  // email-based key for public endpoints
  if (keyType === 'email' && req.body?.email) return `email:${String(req.body.email).toLowerCase()}`;
  return `ip:${req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown'}`;
}

// options: { windowMs, max, keyType }
exports.rateLimit = (options = {}) => {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 5;
  const keyType = options.keyType || 'ip';
  return (req, res, next) => {
    try {
      const key = makeKey(req, keyType);
      const now = Date.now();
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      const arr = buckets.get(key);
      // prune
      while (arr.length && (now - arr[0]) > windowMs) arr.shift();
      if (arr.length >= max) {
        return res.status(429).json({ status: 'error', message: 'Too many attempts, please try again later.' });
      }
      arr.push(now);
      buckets.set(key, arr);
      next();
    } catch (e) {
      next();
    }
  };
};
