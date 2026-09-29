/**
 * Read one text field out of a multipart body.
 *
 * A multipart form can legitimately carry the same field name more than once -
 * that is exactly how `photos` and `capturedAt` arrive as arrays - so multer
 * hands back an array whenever a name repeats. Every route that read
 * `req.body.title` as a string was therefore one duplicated field away from
 * `.trim is not a function` and a 500, whether the duplicate came from a buggy
 * client or someone poking at the API.
 *
 * Taking the last value matches how HTML form processing generally treats
 * repeats, and is the one a user's final edit would produce.
 */
function textField(value, fallback = '') {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (raw === undefined || raw === null) return fallback;

  // Objects can appear here too: multer parses `title[x]=y` into one.
  if (typeof raw === 'object') return fallback;

  return String(raw);
}

module.exports = { textField };
