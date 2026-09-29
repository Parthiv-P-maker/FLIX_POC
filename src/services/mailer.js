/**
 * Where outbound mail goes.
 *
 * There is no SMTP account behind this project, and inventing one would mean
 * either committing credentials or shipping a flow that silently does nothing.
 * So delivery is a seam: the whole reset flow - token generation, hashing,
 * expiry, single use, the timing-safe lookup - is real and tested, and only
 * the last step is stubbed.
 *
 * In development the link is printed to the server console, which is enough to
 * exercise the flow by hand. Swapping in nodemailer is a change to this file
 * alone: implement send() and drop the console branch.
 *
 * Deliberately NOT a silent no-op. A password reset that appears to work and
 * delivers nothing is worse than one that is obviously not wired up, so the
 * console output says so in as many words.
 */

const DELIVERY = process.env.MAIL_TRANSPORT || 'console';

function renderResetEmail({ to, resetUrl, expiresInMinutes }) {
  return {
    to,
    subject: 'Reset your FlixDrive password',
    text: [
      'Someone asked to reset the password on this FlixDrive account.',
      '',
      `Open this link to choose a new one: ${resetUrl}`,
      '',
      `The link works once and expires in ${expiresInMinutes} minutes.`,
      'If this was not you, ignore this message - nothing has changed.',
    ].join('\n'),
  };
}

async function send(message) {
  if (DELIVERY === 'console') {
    console.log(
      [
        '',
        '  ┌─ MAIL NOT SENT — no transport configured ────────────────',
        `  │  to:      ${message.to}`,
        `  │  subject: ${message.subject}`,
        '  │',
        ...message.text.split('\n').map((line) => `  │  ${line}`),
        '  └──────────────────────────────────────────────────────────',
        '',
      ].join('\n')
    );
    return { delivered: false, transport: 'console' };
  }

  // A deployment that sets MAIL_TRANSPORT to anything else is asking for real
  // delivery, and must not get the console fallback by accident.
  throw new Error(`MAIL_TRANSPORT="${DELIVERY}" is set but no such transport is implemented`);
}

module.exports = { send, renderResetEmail, DELIVERY };
