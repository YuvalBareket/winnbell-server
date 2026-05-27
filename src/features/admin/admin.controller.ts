import { Request, Response } from 'express';
import {
  closeDrawService,
  openDrawService,
  reopenDrawService,
  createBusinessService,
  getPromoCodesService,
  createPromoCodeService,
  deactivatePromoCodeService,
  createDrawService,
  updateDrawService,
  deleteDrawService,
  getActiveDraws,
  getAllDrawsService,
  getBusinessesWithStats,
  pickDrawWinnerService,
  getAdminOverviewService,
  getAllUsersService,
  updateUserRoleService,
  toggleUserActiveService,
  getPlatformSettingsService,
  updatePlatformSettingsService,
  getFoundingMembersTakenCount,
  getDrawBusinessesService,
  getAdminAnalyticsService,
  getLocationBreakdownService,
  adminSetUserRiskService,
  getUserDetailService,
  getEntryVolumeService,
  getCampaignComparisonService,
  duplicateDrawService,
} from './admin.service.js';

export const getDashboardData = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
    const search = (req.query.search as string) || undefined;
    const stats = await getBusinessesWithStats({ page, limit, search });
    res.status(200).json(stats);
  } catch (error) {
    console.error('[admin.getDashboardData]', error);
    res.status(500).json({ message: 'Error fetching admin data' });
  }
};

export const getDraws = async (req: Request, res: Response) => {
  try {
    const draws = await getActiveDraws();
    res.status(200).json(draws);
  } catch (error) {
    console.error('[admin.getDraws]', error);
    res.status(500).json({ message: 'Error fetching campaigns' });
  }
};

export const createBusiness = async (req: Request, res: Response) => {
  try {
    const business = await createBusinessService(req.body);
    res.status(201).json(business);
  } catch (error: unknown) {
    console.error('[admin.createBusiness]', error);
    res.status(500).json({ message: 'Failed to create business' });
  }
};
export const getAllDraws = async (req: Request, res: Response) => {
  try {
    const draws = await getAllDrawsService();
    res.status(200).json(draws);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching all campaigns' });
  }
};

export const createDraw = async (req: Request, res: Response) => {
  const { prize_amount } = req.body as { prize_amount?: number };
  const parsed = Number(prize_amount);
  if (!prize_amount || isNaN(parsed) || parsed <= 0) {
    res.status(400).json({ message: 'prize_amount must be a positive number' });
    return;
  }
  try {
    const draw = await createDrawService(req.body);
    res.status(201).json(draw);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create campaign' });
  }
};

export const updateDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  if (isNaN(drawId)) {
    res.status(400).json({ message: 'Invalid drawId' });
    return;
  }
  const { name, prize_amount, draw_date } = req.body as {
    name?: string;
    prize_amount?: number;
    draw_date?: string;
  };
  if (prize_amount !== undefined && (isNaN(Number(prize_amount)) || Number(prize_amount) <= 0)) {
    res.status(400).json({ message: 'prize_amount must be a positive number' });
    return;
  }
  try {
    const draw = await updateDrawService(drawId, { name, prize_amount: prize_amount ? Number(prize_amount) : undefined, draw_date });
    res.json(draw);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update campaign';
    res.status(400).json({ message });
  }
};

export const deleteDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  if (isNaN(drawId)) {
    res.status(400).json({ message: 'Invalid drawId' });
    return;
  }
  try {
    await deleteDrawService(drawId);
    res.status(204).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete campaign';
    res.status(400).json({ message });
  }
};

export const openDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  try {
    await openDrawService(drawId);
    res.status(200).json({ message: 'Campaign opened successfully' });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to open campaign' });
  }
};

export const closeDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  try {
    await closeDrawService(drawId);
    res.status(200).json({ message: 'Campaign closed successfully' });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to close campaign' });
  }
};

export const getOverview = async (req: Request, res: Response) => {
  try {
    const data = await getAdminOverviewService();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch overview' });
  }
};

export const getUsers = async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : undefined;
  const role = typeof req.query.role === 'string' && req.query.role ? req.query.role : undefined;
  const riskLevel = ['high', 'medium', 'low'].includes(req.query.riskLevel as string)
    ? (req.query.riskLevel as 'high' | 'medium' | 'low')
    : undefined;
  try {
    const result = await getAllUsersService({ page, limit, search, role, riskLevel });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

export const updateUserRole = async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId as string, 10);
  if (isNaN(userId)) {
    res.status(400).json({ message: 'Invalid userId' });
    return;
  }
  const { role } = req.body;
  if (typeof role !== 'string') {
    res.status(400).json({ message: 'role must be a string' });
    return;
  }
  try {
    await updateUserRoleService(userId, role);
    res.status(200).json({ message: 'Role updated' });
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Failed to update role' });
  }
};

export const toggleUserActive = async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId as string, 10);
  const { is_active } = req.body;
  try {
    await toggleUserActiveService(userId, !!is_active);
    res.status(200).json({ message: 'User status updated' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update user status' });
  }
};

export const getDrawBusinesses = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  try {
    const businesses = await getDrawBusinessesService(drawId);
    res.json(businesses);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch campaign businesses' });
  }
};

export const getPlatformSettings = async (_req: Request, res: Response) => {
  try {
    const settings = await getPlatformSettingsService();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch platform settings' });
  }
};

export const updatePlatformSettings = async (req: Request, res: Response) => {
  try {
    const { global_entry_cap, allowed_states, founding_member_cap, founding_phase_active } = req.body as {
      global_entry_cap: number | null;
      allowed_states?: string[];
      founding_member_cap?: number;
      founding_phase_active?: boolean;
    };

    if (global_entry_cap !== null && global_entry_cap !== undefined) {
      const parsed = Number(global_entry_cap);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ message: 'global_entry_cap must be a positive integer or null' });
        return;
      }
    }

    if (founding_member_cap !== undefined) {
      const parsed = Number(founding_member_cap);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ message: 'founding_member_cap must be a positive integer' });
        return;
      }
      const taken = await getFoundingMembersTakenCount();
      if (parsed < taken) {
        res.status(400).json({ message: `Cannot set cap below current founding member count (${taken})` });
        return;
      }
    }

    await updatePlatformSettingsService(global_entry_cap ?? null, allowed_states, founding_member_cap, founding_phase_active);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update platform settings' });
  }
};

export const pickWinner = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  if (isNaN(drawId)) {
    res.status(400).json({ message: 'Invalid drawId' });
    return;
  }
  try {
    const winner = await pickDrawWinnerService(drawId);
    res.status(200).json(winner);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to pick winner';
    res.status(500).json({ message });
  }
};

export const reopenDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  try {
    await reopenDrawService(drawId);
    res.status(200).json({ message: 'Campaign reopened successfully' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reopen campaign';
    res.status(500).json({ message });
  }
};

export const getPromoCodes = async (_req: Request, res: Response) => {
  try {
    const codes = await getPromoCodesService();
    res.json(codes);
  } catch (error) {
    console.error('[admin.getPromoCodes]', error);
    res.status(500).json({ message: 'Failed to fetch promo codes' });
  }
};

export const createPromoCode = async (req: Request, res: Response) => {
  const { code, max_uses } = req.body as { code: string; max_uses?: number | null };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ message: 'code is required' });
    return;
  }
  try {
    const result = await createPromoCodeService(code, max_uses);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Failed to create promo code' });
  }
};

export const deactivatePromoCode = async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ message: 'Invalid id' });
    return;
  }
  try {
    await deactivatePromoCodeService(id);
    res.status(204).send();
  } catch (error) {
    console.error('[admin.deactivatePromoCode]', error);
    res.status(500).json({ message: 'Failed to deactivate promo code' });
  }
};

export const getAnalytics = async (req: Request, res: Response) => {
  const rawBiz = req.query.businessId;
  const rawDraw = req.query.drawId;
  const businessId = rawBiz ? parseInt(rawBiz as string, 10) : undefined;
  const drawId = rawDraw ? parseInt(rawDraw as string, 10) : undefined;
  if (rawBiz !== undefined && (isNaN(businessId!) || businessId! < 1)) {
    res.status(400).json({ message: 'businessId must be a positive integer' });
    return;
  }
  if (rawDraw !== undefined && (isNaN(drawId!) || drawId! < 1)) {
    res.status(400).json({ message: 'drawId must be a positive integer' });
    return;
  }
  try {
    const data = await getAdminAnalyticsService(businessId, drawId);
    res.json(data);
  } catch (error) {
    console.error('[admin.getAnalytics]', error);
    res.status(500).json({ message: 'Failed to fetch analytics' });
  }
};

export const setUserRisk = async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId as string, 10);
  if (isNaN(userId)) {
    res.status(400).json({ message: 'Invalid userId' });
    return;
  }
  const { risk_score } = req.body as { risk_score: number };
  if (typeof risk_score !== 'number' || risk_score < 0) {
    res.status(400).json({ message: 'risk_score must be a non-negative number' });
    return;
  }
  try {
    await adminSetUserRiskService(userId, risk_score);
    res.status(200).json({ message: 'Risk score updated' });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to update risk score' });
  }
};

export const getUserDetail = async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId as string, 10);
  if (isNaN(userId)) {
    res.status(400).json({ message: 'Invalid userId' });
    return;
  }
  try {
    const detail = await getUserDetailService(userId);
    if (!detail) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    res.json(detail);
  } catch (error) {
    console.error('[admin.getUserDetail]', error);
    res.status(500).json({ message: 'Failed to fetch user detail' });
  }
};

export const getLocationBreakdown = async (req: Request, res: Response) => {
  const rawBiz = req.query.businessId;
  const rawPage = req.query.page;
  const rawLimit = req.query.limit;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;

  const businessId = rawBiz ? parseInt(rawBiz as string, 10) : undefined;
  const page = rawPage ? parseInt(rawPage as string, 10) : 1;
  const limit = rawLimit ? Math.min(parseInt(rawLimit as string, 10), 100) : 25;

  if (rawBiz !== undefined && (isNaN(businessId!) || businessId! < 1)) {
    res.status(400).json({ message: 'businessId must be a positive integer' });
    return;
  }
  if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1) {
    res.status(400).json({ message: 'Invalid page or limit' });
    return;
  }
  try {
    const data = await getLocationBreakdownService({ businessId, search, page, limit });
    res.json(data);
  } catch (error) {
    console.error('[admin.getLocationBreakdown]', error);
    res.status(500).json({ message: 'Failed to fetch location breakdown' });
  }
};

export const getEntryVolume = async (req: Request, res: Response) => {
  const drawId = req.query.drawId ? parseInt(req.query.drawId as string, 10) : undefined;
  const businessId = req.query.businessId ? parseInt(req.query.businessId as string, 10) : undefined;
  try {
    const data = await getEntryVolumeService(drawId, businessId);
    res.json(data);
  } catch (error) {
    console.error('[admin.getEntryVolume]', error);
    res.status(500).json({ message: 'Failed to fetch entry volume' });
  }
};

export const getCampaignComparison = async (_req: Request, res: Response) => {
  try {
    const data = await getCampaignComparisonService();
    res.json(data);
  } catch (error) {
    console.error('[admin.getCampaignComparison]', error);
    res.status(500).json({ message: 'Failed to fetch campaign comparison' });
  }
};

export const duplicateDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId as string, 10);
  if (isNaN(drawId)) {
    res.status(400).json({ message: 'Invalid drawId' });
    return;
  }
  try {
    const draw = await duplicateDrawService(drawId);
    res.status(201).json(draw);
  } catch (error) {
    console.error('[admin.duplicateDraw]', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to duplicate draw' });
  }
};
