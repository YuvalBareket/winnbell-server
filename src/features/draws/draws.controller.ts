import { Request, Response } from 'express';
import { getActiveDrawService, getDrawHistoryService, getDrawResultService } from './draws.service.js';

export const getActiveDraws = async (req: Request, res: Response) => {
  try {
    const result = await getActiveDrawService();
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Failed to fetch active campaigns' });
  }
};

export const getDrawHistory = async (req: Request, res: Response) => {
  try {
    const result = await getDrawHistoryService();
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Failed to fetch campaign history' });
  }
};

export const getDrawResult = async (req: Request, res: Response) => {
  try {
    const drawId = parseInt(req.params.drawId as string);
    const result = await getDrawResultService(drawId);
    res.status(200).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Campaign not found';
    res.status(404).json({ message });
  }
};
