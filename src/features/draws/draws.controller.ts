import { Request, Response } from 'express';
import { getActiveDrawService, getDrawHistoryService, getDrawResultService } from './draws.service.js';

export const getActiveDraws = async (req: Request, res: Response) => {
  try {
    const result = await getActiveDrawService();
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};

export const getDrawHistory = async (req: Request, res: Response) => {
  try {
    const result = await getDrawHistoryService();
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};

export const getDrawResult = async (req: Request, res: Response) => {
  try {
    const drawId = parseInt(req.params.drawId as string);
    const result = await getDrawResultService(drawId);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(404).json({ message: error.message });
  }
};
