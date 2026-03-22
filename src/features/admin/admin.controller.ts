import { Request, Response } from 'express';
import {
  createBusinessService,
  createDrawService,
  generateBatchTickets,
  getActiveDraws,
  getAllDrawsService,
  getBusinessesWithStats,
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

export const createTickets = async (req: Request, res: Response) => {
  const { businessId, drawId, quantity } = req.body;
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
