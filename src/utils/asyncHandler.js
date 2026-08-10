/**
 * Express 4 does not catch rejections from async route handlers - it just
 * leaves the request hanging until it times out. Wrapping every async handler
 * routes the rejection into next(), so errorHandler sees it.
 */
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
