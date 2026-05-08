import { Request, Response } from 'express';
import {
  closeDrawService,
  openDrawService,
  createBusinessService,
  getPromoCodesService,
  createPromoCodeService,
  deactivatePromoCodeService,
  createDrawService,
  generateBatchTickets,
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
  getDrawBusinessesService,
  getAdminAnalyticsService,
  getLocationBreakdownService,
  adminSetUserRiskService,
} from './admin.service.js';

export const getDashboardData = async (req: Request, res: Response) => {
  try {
    const stats = await getBusinessesWithStats();
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

const MAX_BATCH_QUANTITY = 500;

export const createTickets = async (req: Request, res: Response) => {
  const { businessId, drawId, quantity } = req.body;
  if (
    !Number.isInteger(businessId) || businessId < 1 ||
    !Number.isInteger(drawId) || drawId < 1 ||
    !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BATCH_QUANTITY
  ) {
    res.status(400).json({ message: `businessId, drawId, and quantity must be positive integers; quantity max ${MAX_BATCH_QUANTITY}` });
    return;
  }
  try {
    const result = await generateBatchTickets(businessId, drawId, quantity);
    res
      .status(201)
      .json({ message: 'Entries generated successfully', ...result });
  } catch (error) {
    console.error('[admin.createTickets]', error);
    res.status(500).json({ message: 'Failed to generate entries' });
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
  try {
    const users = await getAllUsersService();
    res.status(200).json(users);
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
    const { global_entry_cap } = req.body as { global_entry_cap: number | null };
    if (global_entry_cap !== null && global_entry_cap !== undefined) {
      const parsed = Number(global_entry_cap);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ message: 'global_entry_cap must be a positive integer or null' });
        return;
      }
    }
    await updatePlatformSettingsService(global_entry_cap ?? null);
    res.status(204).send();
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
    console.error('[admin.pickWinner]', error);
    res.status(500).json({ message: 'Failed to pick winner' });
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
  const businessId = rawBiz ? parseInt(rawBiz as string, 10) : undefined;
  if (rawBiz !== undefined && (isNaN(businessId!) || businessId! < 1)) {
    res.status(400).json({ message: 'businessId must be a positive integer' });
    return;
  }
  try {
    const data = await getAdminAnalyticsService(businessId);
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
