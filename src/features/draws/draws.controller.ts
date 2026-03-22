import { Request, Response } from 'express';
import { getActiveDrawService } from './draws.service.js';

export const getActiveDraws = async (req: Request, res: Response) => {
  try {
    const result = await getActiveDrawService();
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};
