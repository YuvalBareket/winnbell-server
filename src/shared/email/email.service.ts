import nodemailer from 'nodemailer';

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
  const subject = `Your Winnbell subscription is active — ${businessName}`;

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
            <td style="background:linear-gradient(135deg,#7fa6ff 0%,#06347e 100%);border-radius:12px 12px 0 0;padding:36px 40px;text-align:center;">
              <p style="margin:0;font-size:28px;font-family:'Georgia',serif;color:white;letter-spacing:-0.5px;">Winnbell</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.75);font-size:14px;">Your subscription is confirmed</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b;">
                Welcome to Winnbell, ${businessName}!
              </p>
              <p style="margin:0 0 28px;color:#64748b;font-size:15px;line-height:1.6;">
                Your subscription is now active and your business is enrolled in the upcoming campaign.
              </p>

              <!-- Plan summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;padding:24px;margin-bottom:28px;">
                <tr>
                  <td style="padding:6px 0;">
                    <span style="color:#64748b;font-size:13px;">Plan</span>
                    <span style="float:right;font-weight:700;color:#1e293b;font-size:13px;">${plan.entriesPerLocation} entries / location / ${intervalLabel}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;border-top:1px solid #e2e8f0;">
                    <span style="color:#64748b;font-size:13px;">Locations</span>
                    <span style="float:right;font-weight:700;color:#1e293b;font-size:13px;">${plan.locationCount}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;border-top:1px solid #e2e8f0;">
                    <span style="color:#64748b;font-size:13px;">Billing</span>
                    <span style="float:right;font-weight:700;color:#195de6;font-size:15px;">$${totalMonthly.toFixed(2)} / ${intervalLabel}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.6;">
                Your entries will be distributed to customers when they submit receipts from your location.
                You can manage your subscription, view statistics, and track entries from your dashboard.
              </p>

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#195de6;border-radius:8px;padding:12px 24px;">
                    <a href="${process.env.FRONTEND_URL ?? 'https://winnbell.com'}/subscription/manage"
                       style="color:white;text-decoration:none;font-weight:700;font-size:14px;">
                      Go to Dashboard →
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
  console.log(`[Email] Subscription confirmation sent to ${toEmail}`);
};
