/**
 * Builds a minimal but spec-correct EXIF APP1 segment carrying
 * DateTimeOriginal, and splices it into a JPEG after the SOI marker.
 *
 * ffmpeg cannot write EXIF, so fixtures need this to exercise capture-date
 * grouping. Without it the tests would only ever cover the upload-time
 * fallback - which is how a real bug in the EXIF path went unnoticed once.
 */
const two = (n) => String(n).padStart(2, '0');

function exifSegment(date) {
  const stamp =
    `${date.getFullYear()}:${two(date.getMonth() + 1)}:${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  const ascii = Buffer.from(stamp + '\0', 'ascii');   // 20 bytes, EXIF-spec length

  // DateTimeOriginal lives in the Exif SubIFD, not IFD0. Written to IFD0 it is
  // still readable, but parsers report it by its numeric id instead of its
  // name - which is exactly the shape a real camera would never produce.
  const IFD0_AT = 8;
  const SUBIFD_AT = IFD0_AT + 2 + 12 + 4;             // 26
  const ASCII_AT = SUBIFD_AT + 2 + 12 + 4;            // 44

  const tiff = Buffer.alloc(ASCII_AT + ascii.length);
  tiff.write('MM', 0);                                // big-endian
  tiff.writeUInt16BE(42, 2);                          // TIFF magic
  tiff.writeUInt32BE(IFD0_AT, 4);

  let o = IFD0_AT;
  tiff.writeUInt16BE(1, o); o += 2;                   // IFD0: one entry
  tiff.writeUInt16BE(0x8769, o); o += 2;              // ExifIFDPointer
  tiff.writeUInt16BE(4, o); o += 2;                   // type LONG
  tiff.writeUInt32BE(1, o); o += 4;                   // count
  tiff.writeUInt32BE(SUBIFD_AT, o); o += 4;           // -> SubIFD
  tiff.writeUInt32BE(0, o); o += 4;                   // no next IFD

  o = SUBIFD_AT;
  tiff.writeUInt16BE(1, o); o += 2;                   // SubIFD: one entry
  tiff.writeUInt16BE(0x9003, o); o += 2;              // DateTimeOriginal
  tiff.writeUInt16BE(2, o); o += 2;                   // type ASCII
  tiff.writeUInt32BE(ascii.length, o); o += 4;
  tiff.writeUInt32BE(ASCII_AT, o); o += 4;
  tiff.writeUInt32BE(0, o);                           // no next IFD

  ascii.copy(tiff, ASCII_AT);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);                    // APP1
  header.writeUInt16BE(payload.length + 2, 2);        // length includes itself
  return Buffer.concat([header, payload]);
}

/** Returns a new JPEG buffer with the given capture date embedded. */
function withCaptureDate(jpegBuffer, date) {
  return Buffer.concat([
    jpegBuffer.subarray(0, 2),   // SOI
    exifSegment(date),
    jpegBuffer.subarray(2),
  ]);
}

module.exports = { exifSegment, withCaptureDate };
