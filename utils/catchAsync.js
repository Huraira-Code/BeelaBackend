// This is a simple wrapper function that catches errors in async functions and passes them to Express's error handling middleware
module.exports = fn => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};
