import nodemailer from 'nodemailer';
import { WINNBELL_LOGO_BASE64 } from './winnbell-logo.data.js';
import { nextChargeAtNy, nextCampaignOpensNy, CHARGE_DAY_OF_MONTH } from '../dates.js';

// "9" -> "9th", "21" -> "21st", "24" -> "24th". Keeps the billing copy in sync with the
// actual charge day (CHARGE_DAY_OF_MONTH) so the email never names the wrong date.
const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
const CHARGE_DAY_LABEL = `the ${ordinal(CHARGE_DAY_OF_MONTH)}`;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM ?? 'Winnbell <no-reply@winnbell.com>';

// The white Winnbell wordmark, embedded as a CID inline attachment (Gmail/Outlook do not
// render SVG and block many remote images; an embedded image always shows, with no
// dependency on the asset being publicly hosted). Loaded once at startup; if it is missing
// the templates fall back to the `alt` text so sending never breaks. Brand blue gradient
// reused across every celebratory email header.
const LOGO_CID = 'winnbell-logo';
const LOGO_SRC = `cid:${LOGO_CID}`;
const BRAND_GRADIENT = 'linear-gradient(135deg,#7fa6ff 0%,#06347e 100%)';

const logoBuffer = Buffer.from(WINNBELL_LOGO_BASE64, 'base64');

// Attachment list for the brand logo (embedded so it always renders and needs no hosting).
const logoAttachments = () =>
  [{ filename: 'winnbell.png', content: logoBuffer, cid: LOGO_CID, contentType: 'image/png' }];

// ─── Subscription Confirmation ────────────────────────────────────────────────
// The "you're all set" congrats email. It is deliberately NOT an invoice: checkout only
// saves the card, and the first real charge lands on the 24th (window signups between the
// 24th and the campaign open are the exception - they pay the upcoming campaign at once).
// The email spells out exactly which of the two happened so the business is never
// surprised by when money moves.

const fmtNyDate = (d: Date) =>
  d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
const fmtNyMonth = (d: Date) =>
  d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long' });

export const sendSubscriptionConfirmationEmail = async (
  toEmail: string,
  businessName: string,
  plan: {
    planName: string;
    entriesPerLocation: number;
    monthlyFee: number;
    locationCount: number;
    chargedToday: boolean;
  },
): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping subscription confirmation email');
    return;
  }

  const baseUrl = process.env.FRONTEND_URL ?? 'https://winnbell.com';
  const now = new Date();
  const campaignOpen = nextCampaignOpensNy(now);   // 1st of next month: the campaign they join
  const nextCharge = nextChargeAtNy(now);          // the next 24th
  const openMonth = fmtNyMonth(campaignOpen);
  const openDate = fmtNyDate(campaignOpen);
  const total = plan.monthlyFee;
  const totalLabel = `$${total.toLocaleString('en-US')}`;
  const locationLabel = `${plan.locationCount} location${plan.locationCount !== 1 ? 's' : ''}`;

  // The one paragraph that kills the billing confusion. Both variants are exact.
  const billingHtml = plan.chargedToday
    ? `<strong style="color:#0f2747;">Your card was charged ${totalLabel} today.</strong> Because this month's
       billing day (${CHARGE_DAY_LABEL}) had already passed when you signed up, today's payment covers the
       <strong style="color:#0f2747;">${openMonth} campaign</strong> directly. Your next charge will be on
       <strong style="color:#0f2747;">${fmtNyDate(nextCharge)}</strong> and pays for the campaign after.
       This email is your confirmation, not an invoice.`
    : `<strong style="color:#0f2747;">No charge was made today.</strong> Your card was saved securely and this
       email is your confirmation, not an invoice. Your first payment of
       <strong style="color:#0f2747;">${totalLabel}</strong> will be charged on
       <strong style="color:#0f2747;">${fmtNyDate(nextCharge)}</strong>, and it covers the
       <strong style="color:#0f2747;">${openMonth} campaign</strong>. After that, each charge on ${CHARGE_DAY_LABEL} pays
       for the campaign that opens on the 1st of the following month. If you cancel from your dashboard, your plan stays
       active through the paid period and simply does not renew after that.`;

  const steps: Array<{ title: string; body: string }> = [
    {
      title: 'You join the next campaign',
      body: `The current campaign is already running, so your spot is reserved for the ${openMonth} campaign. When it opens on ${openDate}, ${businessName} appears on the Winnbell map and customers can start entering.`,
    },
    {
      title: 'Get your storefront ready',
      body: 'Download your QR code, posters, and ready-to-share posts from the Marketing page. Your receipt guide shows customers exactly which number on the receipt to enter.',
    },
    {
      title: 'Watch entries roll in',
      body: 'Track live entries, new customers, and campaign performance from your Campaign Dashboard.',
    },
  ];

  const stepsHtml = steps.map((s, i) => `
                <tr>
                  <td style="padding:0 0 16px;vertical-align:top;width:44px;">
                    <div style="width:30px;height:30px;border-radius:9px;background:#e9f2fd;color:#1565c0;font-size:13px;font-weight:700;text-align:center;line-height:30px;">${i + 1}</div>
                  </td>
                  <td style="padding:0 0 16px;vertical-align:top;">
                    <div style="font-size:14px;font-weight:700;color:#0f2747;">${s.title}</div>
                    <div style="font-size:13px;color:#475569;line-height:1.6;margin-top:2px;">${s.body}</div>
                  </td>
                </tr>`).join('');

  const subject = `You're all set, ${businessName}! Your Winnbell subscription is active`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 0;">
    <tr>
      <td align="center">
        <!-- email card -->
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(15,39,71,.4);">

          <!-- header band -->
          <tr>
            <td style="background:linear-gradient(160deg,#42a5f5 0%,#1565c0 52%,#0f3a6b 100%);padding:34px 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${LOGO_SRC}" alt="Winnbell" style="height:22px;width:auto;display:block;" />
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.24);border-radius:999px;padding:5px 12px;font-size:11px;font-weight:700;color:#ffffff;">
                      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#4ade80;margin-right:6px;"></span>Subscription active
                    </span>
                  </td>
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
                <tr>
                  <td align="center">
                    <div style="width:74px;height:74px;border-radius:50%;background:rgba(255,255,255,.16);border:2px solid rgba(255,255,255,.32);margin:0 auto 18px;text-align:center;">
                      <div style="width:52px;height:52px;border-radius:50%;background:#ffffff;margin:11px auto 0;text-align:center;line-height:52px;font-size:26px;font-weight:700;color:#2e7d32;">&#10003;</div>
                    </div>
                    <div style="font-size:27px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;line-height:1.2;">You're all set, ${businessName}!</div>
                    <div style="font-size:14px;color:rgba(255,255,255,.82);font-weight:500;line-height:1.6;max-width:400px;margin:10px auto 0;">Welcome to Winnbell. Your business is officially part of the local rewards network that brings customers back.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- body -->
          <tr>
            <td style="padding:34px 40px 8px;">

              <p style="margin:0;font-size:14.5px;color:#475569;line-height:1.7;">Congratulations! You've joined a growing community of local shops turning everyday receipts into repeat visits. Below is everything you signed up for and exactly how billing works - keep this email as your confirmation.</p>

              <!-- plan summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border:1px solid #e7edf4;border-radius:16px;overflow:hidden;">
                <tr>
                  <td colspan="2" style="height:4px;background:linear-gradient(90deg,#42a5f5,#0f3a6b);font-size:0;line-height:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td colspan="2" style="padding:20px 22px 0;">
                    <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Your plan</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 0 20px 22px;vertical-align:bottom;">
                    <div style="font-size:17px;font-weight:700;color:#0f2747;">${plan.planName} &middot; ${locationLabel}</div>
                    <div style="font-size:12.5px;color:#94a3b8;font-weight:600;margin-top:3px;">${plan.entriesPerLocation.toLocaleString('en-US')} entries per location, every campaign</div>
                  </td>
                  <td align="right" style="padding:14px 22px 20px 0;vertical-align:bottom;">
                    <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0f2747;">${totalLabel}<span style="font-size:12.5px;font-weight:600;color:#94a3b8;"> / mo</span></div>
                    <div style="font-size:11.5px;color:#94a3b8;font-weight:600;">billed on ${CHARGE_DAY_LABEL}</div>
                  </td>
                </tr>
              </table>

              <!-- billing explainer: this is NOT an invoice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#f4f8ff;border:1px solid #dcebfb;border-radius:14px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-size:13px;font-weight:700;color:#0f2747;margin-bottom:6px;">About your payment</div>
                    <div style="font-size:13px;color:#475569;line-height:1.65;">${billingHtml}</div>
                  </td>
                </tr>
              </table>

              <!-- what happens next -->
              <div style="margin-top:28px;font-size:15px;font-weight:700;color:#0f2747;">What happens next</div>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
${stepsHtml}
              </table>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
                <tr>
                  <td align="center">
                    <a href="${baseUrl}/campaign" style="display:inline-block;background:linear-gradient(135deg,#1565c0,#0f3a6b);color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;border-radius:13px;padding:15px 30px;box-shadow:0 10px 24px -8px rgba(21,101,192,.5);">Go to your Dashboard</a>
                  </td>
                </tr>
              </table>

              <!-- support -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr>
                  <td align="center" style="padding:22px 0 24px;border-top:1px solid #f1f5f9;">
                    <div style="font-size:13px;color:#475569;line-height:1.6;">Questions about your first campaign? We're here to help. Just reply to this email or reach us at <a href="mailto:support@winnbell.com" style="color:#1565c0;text-decoration:none;font-weight:700;">support@winnbell.com</a>.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td style="padding:24px 40px 30px;background:#f7f9fc;border-top:1px solid #eef2f7;" align="center">
              <div style="font-size:13px;font-weight:700;color:#0f2747;">Winnbell</div>
              <div style="font-size:11px;color:#b0bccb;margin-top:14px;">You're receiving this because you subscribed to Winnbell for Business.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, attachments: logoAttachments() });
  console.log(`[Email] Subscription confirmation sent to ${toEmail}`);
};

// ─── Founding Partner: Welcome ────────────────────────────────────────────────
// The biggest single transaction on the platform deserves a real confirmation. Same
// card design as the subscription confirmation, gold-accented for founding, and the
// payment story is spelled out: one charge today, $0 recurring, covers every campaign
// opening before the term end, no auto-renewal.

export const sendFoundingWelcomeEmail = async (
  toEmail: string,
  businessName: string,
  details: { seatNumber: number; cap: number; termEnd: Date },
): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping founding welcome email');
    return;
  }

  const baseUrl = process.env.FRONTEND_URL ?? 'https://winnbell.com';
  const now = new Date();
  const campaignOpen = nextCampaignOpensNy(now);
  const openMonth = fmtNyMonth(campaignOpen);
  const openDate = fmtNyDate(campaignOpen);
  const termEndLabel = fmtNyDate(details.termEnd);
  const goldGradient = 'linear-gradient(90deg,#fcd34d,#f59e0b)';

  const included: string[] = [
    `<strong style="color:#0f2747;">1,000 entries</strong> per location in every campaign`,
    `Every campaign that opens before <strong style="color:#0f2747;">${termEndLabel}</strong>`,
    `<strong style="color:#0f2747;">One-time payment.</strong> $0 charged monthly, no auto-renewal`,
    `Your locations shown on the <strong style="color:#0f2747;">Winnbell map</strong>`,
  ];
  const includedHtml = included.map((item) => `
                <tr>
                  <td style="padding:0 0 11px;vertical-align:top;width:26px;">
                    <span style="font-size:15px;font-weight:700;color:#f59e0b;">&#10003;</span>
                  </td>
                  <td style="padding:0 0 11px;vertical-align:top;">
                    <span style="font-size:13.5px;color:#334155;line-height:1.5;">${item}</span>
                  </td>
                </tr>`).join('');

  const steps: Array<{ title: string; body: string }> = [
    {
      title: 'You join the next campaign',
      body: `The current campaign is already running, so your spot is reserved for the ${openMonth} campaign. When it opens on ${openDate}, ${businessName} appears on the Winnbell map and customers can start entering.`,
    },
    {
      title: 'Get your storefront ready',
      body: 'Download your QR code, posters, and ready-to-share posts from the Marketing page. Your receipt guide shows customers exactly which number on the receipt to enter.',
    },
    {
      title: 'Watch entries roll in',
      body: 'Track live entries, new customers, and campaign performance from your Campaign Dashboard.',
    },
  ];
  const stepsHtml = steps.map((s, i) => `
                <tr>
                  <td style="padding:0 0 16px;vertical-align:top;width:44px;">
                    <div style="width:30px;height:30px;border-radius:9px;background:#fdf3d8;color:#b45309;font-size:13px;font-weight:700;text-align:center;line-height:30px;">${i + 1}</div>
                  </td>
                  <td style="padding:0 0 16px;vertical-align:top;">
                    <div style="font-size:14px;font-weight:700;color:#0f2747;">${s.title}</div>
                    <div style="font-size:13px;color:#475569;line-height:1.6;margin-top:2px;">${s.body}</div>
                  </td>
                </tr>`).join('');

  const subject = `Welcome, Founding Partner! ${businessName} is locked in for a full year`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 0;">
    <tr>
      <td align="center">
        <!-- email card -->
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(15,39,71,.4);">

          <!-- header band -->
          <tr>
            <td style="background:linear-gradient(160deg,#42a5f5 0%,#1565c0 52%,#0f3a6b 100%);padding:34px 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${LOGO_SRC}" alt="Winnbell" style="height:22px;width:auto;display:block;" />
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.24);border-radius:999px;padding:5px 12px;font-size:11px;font-weight:700;color:#ffffff;">
                      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#fbbf24;margin-right:6px;"></span>Founding Partner
                    </span>
                  </td>
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
                <tr>
                  <td align="center">
                    <div style="width:74px;height:74px;border-radius:50%;background:rgba(255,255,255,.16);border:2px solid rgba(251,191,36,.55);margin:0 auto 18px;text-align:center;">
                      <div style="width:52px;height:52px;border-radius:50%;background:#ffffff;margin:11px auto 0;text-align:center;line-height:52px;font-size:26px;font-weight:700;color:#f59e0b;">&#10003;</div>
                    </div>
                    <div style="font-size:27px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;line-height:1.2;">Welcome aboard, ${businessName}!</div>
                    <div style="font-size:14px;color:rgba(255,255,255,.82);font-weight:500;line-height:1.6;max-width:400px;margin:10px auto 0;">You're officially a Winnbell Founding Partner. A full year of campaigns, one payment, locked in.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- body -->
          <tr>
            <td style="padding:34px 40px 8px;">

              <p style="margin:0;font-size:14.5px;color:#475569;line-height:1.7;">Congratulations, and thank you for backing Winnbell early. You hold founding seat #${details.seatNumber}, and your membership is now active. Below is everything your year includes and exactly how the payment works - keep this email as your confirmation.</p>

              <!-- membership summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border:1px solid #e7edf4;border-radius:16px;overflow:hidden;">
                <tr>
                  <td colspan="2" style="height:4px;background:${goldGradient};font-size:0;line-height:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td colspan="2" style="padding:20px 22px 0;">
                    <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Your founding membership</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 0 16px 22px;vertical-align:bottom;">
                    <div style="font-size:17px;font-weight:700;color:#0f2747;">Founding Partner &middot; seat #${details.seatNumber}</div>
                    <div style="font-size:12.5px;color:#94a3b8;font-weight:600;margin-top:3px;">1,000 entries per location, every campaign</div>
                  </td>
                  <td align="right" style="padding:14px 22px 16px 0;vertical-align:bottom;">
                    <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0f2747;">$1,200<span style="font-size:12.5px;font-weight:600;color:#94a3b8;"> one-time</span></div>
                    <div style="font-size:11.5px;color:#94a3b8;font-weight:600;">then $0 / month for 12 months</div>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding:0 22px 18px;">
                    <div style="border-top:1px solid #f1f5f9;padding-top:14px;">
                      <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;margin-bottom:10px;">What's included</div>
                      <table width="100%" cellpadding="0" cellspacing="0">
${includedHtml}
                      </table>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- payment explainer: one charge, no renewals -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#fffbf0;border:1px solid #f5e3b8;border-radius:14px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-size:13px;font-weight:700;color:#0f2747;margin-bottom:6px;">About your payment</div>
                    <div style="font-size:13px;color:#475569;line-height:1.65;"><strong style="color:#0f2747;">Your card was charged $1,200 today, and that is the only charge.</strong>
                    This email is your confirmation, not an invoice. Nothing is billed monthly, and your membership does not auto-renew.
                    It covers every campaign that opens before <strong style="color:#0f2747;">${termEndLabel}</strong>.
                    Before your final included campaign ends we'll email you, and you can pick a regular monthly plan to continue without missing a day.</div>
                  </td>
                </tr>
              </table>

              <!-- what happens next -->
              <div style="margin-top:28px;font-size:15px;font-weight:700;color:#0f2747;">What happens next</div>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
${stepsHtml}
              </table>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
                <tr>
                  <td align="center">
                    <a href="${baseUrl}/campaign" style="display:inline-block;background:linear-gradient(135deg,#fcd34d,#f59e0b);color:#3a2606;text-decoration:none;font-size:15px;font-weight:700;border-radius:13px;padding:15px 30px;box-shadow:0 10px 24px -8px rgba(245,158,11,.55);">Go to your Dashboard</a>
                  </td>
                </tr>
              </table>

              <!-- support -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr>
                  <td align="center" style="padding:22px 0 24px;border-top:1px solid #f1f5f9;">
                    <div style="font-size:13px;color:#475569;line-height:1.6;">Questions about your founding year? We're here to help. Just reply to this email or reach us at <a href="mailto:support@winnbell.com" style="color:#1565c0;text-decoration:none;font-weight:700;">support@winnbell.com</a>.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td style="padding:24px 40px 30px;background:#f7f9fc;border-top:1px solid #eef2f7;" align="center">
              <div style="font-size:13px;font-weight:700;color:#0f2747;">Winnbell</div>
              <div style="font-size:11px;color:#b0bccb;margin-top:14px;">You're receiving this because you subscribed to Winnbell for Business.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, attachments: logoAttachments() });
  console.log(`[Email] Founding welcome sent to ${toEmail}`);
};

// ─── Dispute Alert (internal) ─────────────────────────────────────────────────
// A chargeback needs a HUMAN decision - this alerts the operator, it does not act.

export const sendDisputeAlertEmail = async (details: {
  businessName: string;
  businessId: number | null;
  amountDollars: number;
  disputeId: string;
  reason: string;
}): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping dispute alert email');
    return;
  }
  const to = process.env.ADMIN_ALERT_EMAIL ?? 'support@winnbell.com';
  const subject = `DISPUTE opened: $${details.amountDollars.toFixed(2)} - ${details.businessName}`;
  const html = `
<p><strong>A payment dispute (chargeback) was opened.</strong></p>
<ul>
  <li>Business: ${details.businessName} (id ${details.businessId ?? 'unknown'})</li>
  <li>Amount: $${details.amountDollars.toFixed(2)}</li>
  <li>Dispute: ${details.disputeId}</li>
  <li>Reason: ${details.reason}</li>
</ul>
<p>No automatic action was taken. Review the dispute in the Stripe dashboard and decide whether the
business should stay in its campaigns.</p>
  `.trim();

  await transporter.sendMail({ from: FROM, to, subject, html });
  console.log(`[Email] Dispute alert sent to ${to}`);
};

// ─── Payment Failed ───────────────────────────────────────────────────────────
// Sent on the FIRST failed attempt of a subscription invoice (Stripe retries follow).
// The business has until the end of the month to fix the card and stay in the next
// campaign - the charge on the 24th pays for the campaign opening on the 1st.

export const sendPaymentFailedEmail = async (
  toEmail: string,
  businessName: string,
  amountDollars: number,
): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping payment failed email');
    return;
  }

  const subject = `Action needed: payment could not be processed — ${businessName}`;
  const manageUrl = `${process.env.FRONTEND_URL ?? 'https://winnbell.com'}/subscription/manage`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);border-radius:12px 12px 0 0;padding:36px 40px;text-align:center;">
              <p style="margin:0;font-size:28px;font-family:'Georgia',serif;color:white;letter-spacing:-0.5px;">Winnbell</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Payment update needed</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b;">
                We could not process your payment
              </p>
              <p style="margin:0 0 20px;color:#64748b;font-size:15px;line-height:1.6;">
                The charge of <strong style="color:#1e293b;">$${amountDollars.toFixed(2)}</strong> for ${businessName}'s next campaign did not go through.
                We will retry automatically over the next few days, but the fastest fix is updating your payment method.
              </p>
              <p style="margin:0 0 28px;color:#64748b;font-size:15px;line-height:1.6;">
                Update your card before the end of the month and your business stays in the next campaign without missing a day.
              </p>

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#195de6;border-radius:8px;padding:12px 24px;">
                    <a href="${manageUrl}"
                       style="color:white;text-decoration:none;font-weight:700;font-size:14px;">
                      Update payment method →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Winnbell · Campaign marketing for local businesses<br/>
                Questions? Reply to this email or contact us at <a href="mailto:support@winnbell.com" style="color:#195de6;">support@winnbell.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html });
  console.log(`[Email] Payment failed notice sent to ${toEmail}`);
};

// ─── Founding Partner: Final Included Campaign ────────────────────────────────
// Sent when a campaign opens and it is the LAST one covered by the founding year.
// The subscribe-by date is the end of the current campaign: starting a regular plan
// before then puts the business in the next campaign with no gap.

export const sendFoundingFinalCampaignEmail = async (
  toEmail: string,
  businessName: string,
  dates: {
    termEnd: Date;             // when the founding year ends
    nextCampaignOpensAt: Date; // 1st of next month - the open the founding year no longer covers
  },
): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping founding final-campaign email');
    return;
  }

  const nextCampaignMonth = dates.nextCampaignOpensAt.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long' });
  // Subscribe deadline = the last day of the CURRENT month (the day before the next open).
  // setUTCDate(0) = day zero of the open's month = last day of the month before it,
  // correct for any month length.
  const subscribeBy = new Date(dates.nextCampaignOpensAt);
  subscribeBy.setUTCDate(0);

  const subject = `Your final Founding Partner campaign is running — ${businessName}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#fbbf24 0%,#d97706 100%);border-radius:12px 12px 0 0;padding:36px 40px;text-align:center;">
              <p style="margin:0;font-size:28px;font-family:'Georgia',serif;color:white;letter-spacing:-0.5px;">Winnbell</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Founding Partner update</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b;">
                Thank you for a great founding year, ${businessName}!
              </p>
              <p style="margin:0 0 20px;color:#64748b;font-size:15px;line-height:1.6;">
                The campaign running right now is the last one included in your Founding Partner year,
                which ends on <strong style="color:#1e293b;">${fmtNyDate(dates.termEnd)}</strong>.
              </p>
              <p style="margin:0 0 28px;color:#64748b;font-size:15px;line-height:1.6;">
                To stay on the Winnbell map and be part of the <strong style="color:#1e293b;">${nextCampaignMonth} campaign</strong>,
                start a regular plan by <strong style="color:#1e293b;">${fmtNyDate(subscribeBy)}</strong>.
                Do it before then and your business will not miss a single day.
              </p>

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#195de6;border-radius:8px;padding:12px 24px;">
                    <a href="${process.env.FRONTEND_URL ?? 'https://winnbell.com'}/subscribe"
                       style="color:white;text-decoration:none;font-weight:700;font-size:14px;">
                      Choose your plan →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0;color:#94a3b8;font-size:13px;line-height:1.6;">
                Your founding benefits stay fully active through the current campaign. Nothing changes until it ends.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Winnbell · Campaign marketing for local businesses<br/>
                Questions? Reply to this email or contact us at <a href="mailto:support@winnbell.com" style="color:#195de6;">support@winnbell.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html });
  console.log(`[Email] Founding final-campaign notice sent to ${toEmail}`);
};

// ─── Contact Form ─────────────────────────────────────────────────────────────
// Public /contact form submissions, delivered to the support inbox. User-supplied text is
// HTML-escaped (the form is public and unauthenticated). reply_to points at the submitter
// so support can answer with a plain reply.

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const sendContactMessageEmail = async (details: {
  fullName: string;
  email: string;
  topic: string;
  message: string;
}): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping contact message email');
    return;
  }
  const to = process.env.SUPPORT_EMAIL ?? 'support@winnbell.com';
  const subject = `Contact form: ${details.topic} - ${details.fullName}`;
  const html = `
<p><strong>New contact form message</strong></p>
<ul>
  <li>From: ${escapeHtml(details.fullName)} &lt;${escapeHtml(details.email)}&gt;</li>
  <li>Topic: ${escapeHtml(details.topic)}</li>
</ul>
<p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:12px;">${escapeHtml(details.message)}</p>
<p>Reply directly to this email to answer them.</p>
  `.trim();

  await transporter.sendMail({ from: FROM, to, replyTo: `${details.fullName} <${details.email}>`, subject, html });
  console.log(`[Email] Contact form message sent to ${to}`);
};
