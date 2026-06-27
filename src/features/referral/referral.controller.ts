import { Request, Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { getOrCreateReferralCode, resolveReferrerByCode } from './referral.service.js';

// GET /referral/link  (auth) — the logged-in user's shareable referral code + full link.
export const getMyReferralLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const code = await getOrCreateReferralCode(userId);
    const base = (process.env.CLIENT_URL || 'http://localhost:8081').split(',')[0].trim();
    res.json({ code, link: `${base}/join?ref=${code}` });
  } catch (err: unknown) {
    console.error('[referral.getMyReferralLink]', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Could not generate your referral link.' });
  }
};

// GET /referral/resolve?ref=<code>  (public) — referrer FIRST NAME for the join landing page.
// Always 200 with { referrerName: string | null } so the landing degrades gracefully.
export const resolveReferral = async (req: Request, res: Response): Promise<void> => {
  try {
    const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
    if (!ref || ref.length > 12) { res.json({ referrerName: null }); return; }
    const referrer = await resolveReferrerByCode(ref);
    res.json({ referrerName: referrer?.firstName ?? null });
  } catch (err: unknown) {
    console.error('[referral.resolveReferral]', err instanceof Error ? err.message : err);
    res.json({ referrerName: null });
  }
};
