import PDFDocument from 'pdfkit';
import { getPool } from '../db/db.js';
import { getPlatformSettings } from '../cache/cache.js';
import { uploadObject, getObject } from '../s3.js';
import { OFFICIAL_RULES_TEMPLATE } from './officialRulesTemplate.js';

// ─── Official Rules archive snapshot ──────────────────────────────────────────
// When a campaign (draw) closes, we archive the EXACT Official Rules that governed
// it - campaign name, dates, prize, and the eligible jurisdictions in force at that
// moment - as a PDF in R2. Legal evidence: "these are the rules that draw ran under."
//
// The substitution logic below MUST stay in lockstep with the client's
// useOfficialRulesContent.ts (the /rules page); the markdown template itself is
// auto-generated from the client file by scripts/sync-official-rules-template.cjs.

const SUPPORT_EMAIL = 'support@winnbell.com';
const COMPANY_ADDRESS = 'Wilmington, Delaware';
// MUST equal MAX_ENTRIES_PER_DRAW in features/tickets/tickets.service.ts (kept as a literal
// here to avoid a shared->features import; the client rules page derives it directly).
// 80 since the September 2026 3-month free-trial campaign (was 30 for monthly campaigns).
const MAX_ENTRIES_PER_USER = '80';
const TIME_ZONE = 'Eastern Time (ET)';
const SITE_ORIGIN = 'https://www.winnbell.com';

// USPS code -> state name (static data; the admin allowed_states setting stores codes).
const STATE_CODE_TO_NAME: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

// Mirrors the client's formatJurisdictions: empty list = the gate is unrestricted
// (all USA). Server reads the setting directly, so there is no error-fallback branch.
export const formatJurisdictions = (codes: string[]): string => {
  if (codes.length === 0) return 'United States (excluding where prohibited by applicable law)';
  const names = codes.map((code) => STATE_CODE_TO_NAME[code] ?? code).sort();
  const list = names.length === 1
    ? names[0]
    : names.length === 2
    ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return `${names.length === 1 ? 'State' : 'States'} of ${list}, United States only`;
};

export interface SnapshotDraw {
  id: number;
  name: string;
  prize_amount: string | null;
  start_date: string | Date | null;
  draw_date: string | Date;
  status?: string;
}

// Campaign-month naming so the archive sorts chronologically and is easy to find:
// key  = legal-snapshots/official-rules/2026-08-august-2026.pdf
// file = winnbell-official-rules-2026-08-august-2026.pdf
export const rulesArchiveNames = (draw: Pick<SnapshotDraw, 'name' | 'draw_date'>): { key: string; filename: string; slug: string } => {
  // en-CA + NY timezone yields "YYYY-MM"; the campaign month is the draw_date's month.
  const ym = new Date(draw.draw_date).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  });
  const slug = draw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campaign';
  return {
    slug,
    key: `legal-snapshots/official-rules/${ym}-${slug}.pdf`,
    filename: `winnbell-official-rules-${ym}-${slug}.pdf`,
  };
};

// Campaign boundaries are NY-timed instants; format them in NY so the archived legal
// dates never shift a day (same rule as the client).
const nyDate = (d: string | Date): string => new Date(d).toLocaleDateString('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric',
});

export const buildOfficialRulesText = (draw: SnapshotDraw, allowedStates: string[]): string => {
  const drawDate = nyDate(draw.draw_date);
  const prizeAmount = draw.prize_amount != null
    ? parseFloat(draw.prize_amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : 'To be announced';
  const startDate = draw.start_date ? nyDate(draw.start_date) : 'See Platform';

  return OFFICIAL_RULES_TEMPLATE
    .replace(/\[Privacy Policy URL\]/g, `${SITE_ORIGIN}/privacy`)
    .replace(/\[Contact Email\]/g, SUPPORT_EMAIL)
    .replace(/<insert postal address of company>/g, COMPANY_ADDRESS)
    .replace(/\[List of Eligible Jurisdictions\]/g, formatJurisdictions(allowedStates))
    .replace(/\[Entry Cap\]/g, MAX_ENTRIES_PER_USER)
    .replace(/\[Time Zone\]/g, TIME_ZONE)
    .replace(/\[If Applicable\]/g, 'None')
    .replace(/\[Additional Campaign-Specific Terms\]/g, 'None')
    .replace(/\[Campaign Name\]/g, draw.name)
    .replace(/\[Start Date & Time\]/g, `${startDate} at 12:00 AM ${TIME_ZONE}`)
    .replace(/\[End Date & Time\]/g, `${drawDate} at 11:59 PM ${TIME_ZONE}`)
    .replace(/\[Draw Date\]/g, drawDate)
    .replace(/\[Prize Description\]/g, `Cash prize of ${prizeAmount}`)
    .replace(/\[Prize Value\]/g, prizeAmount);
};

// ─── Markdown-subset PDF renderer ─────────────────────────────────────────────
// The rules doc only uses: full-line **bold** (headings), inline **bold**, "- " bullets
// (with 2-space nesting), "---" rules, escaped "\." dots, and [text](url) links.
// The archive's job is preserving the exact WORDING; inline emphasis is flattened.

const inlineText = (s: string): string => s
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
    `${text} (${url.startsWith('/') ? SITE_ORIGIN + url : url})`)
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\\([.\\])/g, '$1');

export const renderOfficialRulesPdf = (text: string, footerNote: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 54, left: 58, right: 58 } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BODY = 9.5;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (line.trim() === '') { doc.moveDown(0.45); continue; }
      if (line.trim() === '---') {
        doc.moveDown(0.2);
        doc.moveTo(doc.page.margins.left, doc.y)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .lineWidth(0.5).strokeColor('#999999').stroke();
        doc.moveDown(0.4);
        continue;
      }

      const bulletMatch = line.match(/^(\s*)- (.*)$/);
      const indentMatch = !bulletMatch && line.match(/^(\s+)(.*)$/);
      const trimmed = line.trim();
      const isFullBold = /^\*\*.+\*\*$/.test(trimmed) && !trimmed.slice(2, -2).includes('**');

      if (isFullBold) {
        // Section headings: the document title gets the largest size.
        const heading = inlineText(trimmed);
        const isTitle = heading === 'WINNBELL OFFICIAL RULES';
        doc.moveDown(isTitle ? 0 : 0.35);
        doc.font('Helvetica-Bold').fontSize(isTitle ? 15 : 11).fillColor('#111111')
          .text(heading, { align: isTitle ? 'center' : 'left' });
        doc.moveDown(0.15);
      } else if (bulletMatch) {
        const depth = Math.floor(bulletMatch[1].length / 2);
        doc.font('Helvetica').fontSize(BODY).fillColor('#222222')
          .text(`•  ${inlineText(bulletMatch[2])}`, {
            indent: 14 + depth * 14, align: 'left', lineGap: 1.5,
          });
      } else if (indentMatch) {
        // Continuation paragraph inside a list (indented in the markdown).
        const depth = Math.floor(indentMatch[1].length / 2);
        doc.font('Helvetica').fontSize(BODY).fillColor('#222222')
          .text(inlineText(indentMatch[2]), { indent: 14 + depth * 14, align: 'left', lineGap: 1.5 });
      } else {
        doc.font('Helvetica').fontSize(BODY).fillColor('#222222')
          .text(inlineText(line), { align: 'left', lineGap: 1.5 });
      }
    }

    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666666').text(footerNote, { align: 'left' });
    doc.end();
  });

// ─── Shared generator: draw -> rendered rules PDF ─────────────────────────────
// Used by the close-time R2 archive AND the admin's on-demand download button.
// Jurisdictions always reflect the platform region setting at generation time.
export const generateOfficialRulesPdfForDraw = async (
  drawId: number,
  footerContext: string,
): Promise<{ pdf: Buffer; draw: SnapshotDraw; key: string; filename: string }> => {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, prize_pool AS prize_amount, start_date, draw_date, status FROM draw WHERE id = $1`,
    [drawId],
  );
  const draw = rows[0] as SnapshotDraw | undefined;
  if (!draw) throw new Error('DRAW_NOT_FOUND');

  const settings = await getPlatformSettings();
  const allowedStates: string[] = settings.allowed_states ?? [];

  const text = buildOfficialRulesText(draw, allowedStates);
  const generatedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const pdf = await renderOfficialRulesPdf(
    text,
    `${footerContext} on ${generatedAt} (ET). Campaign: ${draw.name} (draw #${draw.id}). ` +
    `Eligible jurisdictions recorded from the platform region setting in force at generation.`,
  );
  const { key, filename } = rulesArchiveNames(draw);
  return { pdf, draw, key, filename };
};

// ─── Admin retrieval: THE version that governed the draw ──────────────────────
// For a CLOSED draw the archived close-time PDF is the legal record - the template
// or the jurisdictions setting may have changed since, so regenerating would NOT
// reproduce what participants actually saw. Serve the archive byte-exact; only if
// it is missing (close-time upload failed) generate fresh and backfill it.
// Open/Upcoming draws always generate fresh (their rules are still live/changing).
export const getRulesPdfForAdmin = async (
  drawId: number,
): Promise<{ pdf: Buffer; filename: string; source: 'archive' | 'generated' }> => {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, draw_date, status FROM draw WHERE id = $1`,
    [drawId],
  );
  const draw = rows[0] as (SnapshotDraw & { status: string }) | undefined;
  if (!draw) throw new Error('DRAW_NOT_FOUND');

  const { key, filename } = rulesArchiveNames(draw);

  if (draw.status.toUpperCase() === 'CLOSED') {
    const archived = await getObject(key);
    if (archived) return { pdf: archived, filename, source: 'archive' };
    // Archive missing (close-time upload failed): regenerate AND backfill the archive.
    const { pdf } = await generateOfficialRulesPdfForDraw(drawId, 'Archived by Winnbell (backfilled on admin download)');
    await uploadObject(key, pdf, 'application/pdf');
    console.log(`[LegalSnapshot] Backfilled missing archive for closed draw ${draw.id} -> r2:${key}`);
    return { pdf, filename, source: 'generated' };
  }

  // Open/Upcoming: fresh render of the live rules; save the working copy.
  const { pdf } = await generateOfficialRulesPdfForDraw(drawId, 'Generated from the Winnbell admin');
  try {
    await uploadObject(key, pdf, 'application/pdf');
  } catch (r2Err: unknown) {
    // The admin still gets the file; only the working-copy save failed.
    console.error('[LegalSnapshot] admin-download R2 save failed:', r2Err instanceof Error ? r2Err.message : r2Err);
  }
  return { pdf, filename, source: 'generated' };
};

// ─── Entry point: archive the rules of a just-closed draw ─────────────────────
// Fire-and-forget from closeDrawService AFTER the close committed: never throws, so a
// snapshot problem (R2 down, misconfig) can never fail or roll back the close itself.
// Failures are logged loudly for manual re-run via the same function.
export const snapshotOfficialRulesForDraw = async (drawId: number): Promise<string | null> => {
  try {
    const { pdf, draw, key } = await generateOfficialRulesPdfForDraw(drawId, 'Archived by Winnbell at campaign close');
    await uploadObject(key, pdf, 'application/pdf');
    console.log(`[LegalSnapshot] Archived Official Rules for draw ${draw.id} ("${draw.name}") -> r2:${key} (${pdf.length} bytes)`);
    return key;
  } catch (err: unknown) {
    console.error(
      `[LegalSnapshot] CRITICAL: failed to archive Official Rules for draw ${drawId} - ` +
      `re-run snapshotOfficialRulesForDraw(${drawId}) manually once the cause is fixed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};
