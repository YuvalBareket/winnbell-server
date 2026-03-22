import { Request, Response } from 'express';
import * as ticketService from './tickets.service.js';

export const redeemCode = async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    const userId = (req as any).user.id; // From our auth middleware

    const result = await ticketService.activateTicket(code, userId);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};
export const getMyTickets = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id; // From our auth middleware
    const drawId = (req as any).query.draw_id; // From our auth middleware
    const role = (req as any).user.role;
    let result;
    if (role === 'Business') {
      result = await ticketService.getBusinessTicketsService(
        userId,
        Number(drawId),
      );
    } else {
      result = await ticketService.getUserTicketsService(
        userId,
        Number(drawId),
      );
    }
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};
export const getStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user.id; // From middleware
    const status = await ticketService.checkFreeTicketEligibility(userId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ message: 'Error checking status' });
  }
};

export const activate = async (req: Request, res: Response) => {
  try {
    const userId = req.user.id;
    const result = await ticketService.activateFreeTicket(userId);
    res.status(201).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};

// server/src/features/tickets/ticket.controller.ts

export const generateTicket = async (req: Request, res: Response) => {
  try {
    const user_id = (req as any).user.id;
    // 1. Prioritize location_id from Body (Owner) or JWT (Manager)
    const location_id = req.body?.location_id || (req as any).user?.location_id;

    if (!location_id) {
      return res.status(400).json({
        message: 'A specific location is required to issue a ticket.',
      });
    }

    const result = await ticketService.generateTicketService(
      user_id,
      Number(location_id),
    );

    res.status(201).json({
      success: true,
      code: result.code,
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: error.message || 'Failed to generate ticket' });
  }
};
