import nodemailer from 'nodemailer';
import { WINNBELL_LOGO_BASE64 } from './winnbell-logo.data.js';

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

export const sendSubscriptionConfirmationEmail = async (
  toEmail: string,
  businessName: string,
  plan: {
    entriesPerLocation: number;
    billingInterval: 'monthly' | 'yearly';
    monthlyFee: number;
    locationCount: number;
  },
): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping subscription confirmation email');
    return;
  }

  const totalMonthly = plan.monthlyFee;
  const intervalLabel = plan.billingInterval === 'yearly' ? 'year' : 'month';
  const subject = `Welcome to Winnbell, ${businessName}. Your subscription is live.`;

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

          <!-- Hero Header -->
          <tr>
            <td style="background:${BRAND_GRADIENT};border-radius:12px 12px 0 0;padding:40px 40px 36px;text-align:center;">
              <img src="${LOGO_SRC}" alt="Winnbell" width="150" style="width:150px;max-width:55%;height:auto;display:inline-block;" />
              <p style="margin:20px 0 0;font-size:24px;font-weight:800;color:white;letter-spacing:-0.3px;">
                You're in!
              </p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">
                Welcome to Winnbell. We're glad you chose us.
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px;">
              <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#0f172a;">
                Welcome to Winnbell, ${businessName}!
              </p>
              <p style="margin:0 0 28px;color:#475569;font-size:15px;line-height:1.6;">
                Your subscription is active and your business is now part of the Winnbell community. Your entries are ready to reward customers and build loyalty.
              </p>

              <!-- Plan Summary Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#eaf3fd 0%,#d6e6fb 100%);border-radius:10px;padding:24px;margin-bottom:32px;border:1px solid #cfe0f7;">
                <tr>
                  <td style="padding:8px 0;">
                    <span style="color:#1565c0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Plan</span>
                    <span style="float:right;font-weight:700;color:#0f172a;font-size:14px;">${plan.entriesPerLocation} entries / location / ${intervalLabel}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-top:1px solid rgba(21,101,192,0.15);">
                    <span style="color:#1565c0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Locations</span>
                    <span style="float:right;font-weight:700;color:#0f172a;font-size:14px;">${plan.locationCount}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-top:1px solid rgba(21,101,192,0.15);">
                    <span style="color:#1565c0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Billing</span>
                    <span style="float:right;font-weight:700;color:#195de6;font-size:15px;">$${totalMonthly.toFixed(2)} / ${intervalLabel}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;color:#475569;font-size:14px;line-height:1.7;">
                Your entries will be distributed to customers when they submit receipts from your location. Track entries, view customer engagement, and manage your plan from your dashboard.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:linear-gradient(135deg,#42a5f5 0%,#195de6 100%);border-radius:8px;padding:14px 28px;box-shadow:0 4px 12px rgba(21,101,192,0.3);">
                    <a href="${process.env.FRONTEND_URL ?? 'https://winnbell.com'}/subscription/manage"
                       style="color:white;text-decoration:none;font-weight:700;font-size:15px;display:block;letter-spacing:0.3px;">
                      Go to Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
                Questions? We are here to help. Reply to this email or reach out to <a href="mailto:support@winnbell.com" style="color:#195de6;text-decoration:none;">support@winnbell.com</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:28px 40px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7;">
                Winnbell. Campaign marketing for local businesses.<br/>
                <a href="https://winnbell.com" style="color:#195de6;text-decoration:none;">Visit winnbell.com</a>
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

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, attachments: logoAttachments() });
  console.log(`[Email] Subscription confirmation sent to ${toEmail}`);
};

// ─── Founding Partner: Welcome ────────────────────────────────────────────────
// The biggest single transaction on the platform deserves a real confirmation.

export const sendFoundingWelcomeEmail = async (
  toEmail: string,
  businessName: string,
  details: { seatNumber: number; cap: number; termEnd: Date },
): Promise<void> => {
  if (!process.env.SMTP_HOST) {
    console.warn('[Email] SMTP_HOST not configured — skipping founding welcome email');
    return;
  }

  const termEndLabel = details.termEnd.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
  });
  const subject = `Welcome, Founding Partner. ${businessName} is now live.`;

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

          <!-- Hero Header -->
          <tr>
            <td style="background:${BRAND_GRADIENT};border-radius:12px 12px 0 0;padding:40px 40px 36px;text-align:center;">
              <img src="${LOGO_SRC}" alt="Winnbell" width="150" style="width:150px;max-width:55%;height:auto;display:inline-block;" />
              <p style="margin:20px 0 0;font-size:24px;font-weight:800;color:white;letter-spacing:-0.3px;">
                Welcome, Founding Partner!
              </p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">
                Welcome to Winnbell. We're glad you chose us.
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px;">
              <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#0f172a;">
                Welcome aboard, ${businessName}!
              </p>
              <p style="margin:0 0 28px;color:#475569;font-size:15px;line-height:1.7;">
                Thank you for becoming a Founding Partner. Your one-time payment unlocks a full year of Winnbell campaigns, beginning today. Your business enrolls in every monthly campaign opening before <strong style="color:#0f172a;">${termEndLabel}</strong>. No recurring charges. Just growth.
              </p>

              <!-- Founding Benefits Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#eaf3fd 0%,#d6e6fb 100%);border-radius:10px;padding:24px;margin-bottom:32px;border:1px solid #cfe0f7;">
                <tr>
                  <td style="padding:8px 0;">
                    <span style="color:#1565c0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Plan</span>
                    <span style="float:right;font-weight:700;color:#0f172a;font-size:14px;">Founding Partner</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-top:1px solid rgba(21,101,192,0.15);">
                    <span style="color:#1565c0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Entries Per Location</span>
                    <span style="float:right;font-weight:700;color:#0f172a;font-size:14px;">1,000 per month</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-top:1px solid rgba(21,101,192,0.15);">
                    <span style="color:#1565c0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Included Through</span>
                    <span style="float:right;font-weight:700;color:#195de6;font-size:14px;">${termEndLabel}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;color:#475569;font-size:14px;line-height:1.7;">
                Your business appears on the Winnbell map the moment the next campaign opens. Customers will start earning entries from your location right away. View your analytics, track entry volume, and manage your account from your dashboard.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:linear-gradient(135deg,#42a5f5 0%,#195de6 100%);border-radius:8px;padding:14px 28px;box-shadow:0 4px 12px rgba(21,101,192,0.3);">
                    <a href="${process.env.FRONTEND_URL ?? 'https://winnbell.com'}/subscription/manage"
                       style="color:white;text-decoration:none;font-weight:700;font-size:15px;display:block;letter-spacing:0.3px;">
                      Go to Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
                Questions? We are here to help. Reply to this email or reach out to <a href="mailto:support@winnbell.com" style="color:#195de6;text-decoration:none;">support@winnbell.com</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:28px 40px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7;">
                Winnbell. Campaign marketing for local businesses.<br/>
                <a href="https://winnbell.com" style="color:#195de6;text-decoration:none;">Visit winnbell.com</a>
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

  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
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
                which ends on <strong style="color:#1e293b;">${fmt(dates.termEnd)}</strong>.
              </p>
              <p style="margin:0 0 28px;color:#64748b;font-size:15px;line-height:1.6;">
                To stay on the Winnbell map and be part of the <strong style="color:#1e293b;">${nextCampaignMonth} campaign</strong>,
                start a regular plan by <strong style="color:#1e293b;">${fmt(subscribeBy)}</strong>.
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
