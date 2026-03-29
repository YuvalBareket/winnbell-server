import { Request, Response } from 'express';
import {
  closeDrawService,
  openDrawService,
  createBusinessService,
  createDrawService,
  generateBatchTickets,
  getActiveDraws,
  getAllDrawsService,
  getBusinessesWithStats,
  pickDrawWinnerService,
} from './admin.service.js';

export const getDashboardData = async (req: Request, res: Response) => {
  try {
    const stats = await getBusinessesWithStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching admin data', error });
  }
};

export const getDraws = async (req: Request, res: Response) => {
  try {
    const draws = await getActiveDraws();
    res.status(200).json(draws);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching draws', error });
  }
};

const MAX_BATCH_QUANTITY = 500;

export const createTickets = async (req: Request, res: Response) => {
  const { businessId, drawId, quantity } = req.body;
  if (!businessId || !drawId || !quantity || typeof quantity !== 'number' || quantity < 1 || quantity > MAX_BATCH_QUANTITY) {
    res.status(400).json({ message: `quantity must be a number between 1 and ${MAX_BATCH_QUANTITY}` });
    return;
  }
  try {
    const result = await generateBatchTickets(businessId, drawId, quantity);
    res
      .status(201)
      .json({ message: 'Tickets generated successfully', ...result });
  } catch (error) {
    res.status(500).json({ message: 'Failed to generate tickets', error });
  }
};
export const createBusiness = async (req: Request, res: Response) => {
  try {
    const business = await createBusinessService(req.body);
    res.status(201).json(business);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create business', error });
  }
};
export const getAllDraws = async (req: Request, res: Response) => {
  try {
    const draws = await getAllDrawsService();
    res.status(200).json(draws);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching all draws', error });
  }
};

export const createDraw = async (req: Request, res: Response) => {
  try {
    const draw = await createDrawService(req.body);
    res.status(201).json(draw);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create draw', error });
  }
};

export const openDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId, 10);
  try {
    await openDrawService(drawId);
    res.status(200).json({ message: 'Draw opened successfully' });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to open draw' });
  }
};

export const closeDraw = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId, 10);
  try {
    await closeDrawService(drawId);
    res.status(200).json({ message: 'Draw closed successfully' });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to close draw' });
  }
};

export const pickWinner = async (req: Request, res: Response) => {
  const drawId = parseInt(req.params.drawId, 10);
  try {
    const winner = await pickDrawWinnerService(drawId);
    res.status(200).json(winner);
  } catch (error) {
    res.status(500).json({ message: 'Failed to pick winner', error });
  }
};
