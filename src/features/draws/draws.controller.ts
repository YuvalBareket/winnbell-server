import { Request, Response } from 'express';
import { getActiveDrawService, getDrawByIdService, getDrawHistoryService, getDrawResultService } from './draws.service.js';

export const getActiveDraws = async (req: Request, res: Response) => {
  try {
    const result = await getActiveDrawService();
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Failed to fetch active campaigns' });
  }
};

export const getDrawById = async (req: Request, res: Response) => {
  try {
    const drawId = parseInt(req.params.drawId as string, 10);
    if (isNaN(drawId)) { res.status(400).json({ message: 'Invalid draw ID' }); return; }
    const result = await getDrawByIdService(drawId);
    if (!result) { res.status(404).json({ message: 'Campaign not found' }); return; }
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Failed to fetch campaign' });
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
    const drawId = parseInt(req.params.drawId as string, 10);
    if (isNaN(drawId)) { res.status(400).json({ message: 'Invalid draw ID' }); return; }
    const result = await getDrawResultService(drawId);
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(404).json({ message: 'Campaign not found' });
  }
};
