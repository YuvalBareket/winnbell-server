import { Response } from 'express';
import * as ticketService from './tickets.service.js';
import { getBusinessLocationsByUserId } from '../business/business.service.js';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';

export const redeemCode = async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const userId = req.user!.id;

    const result = await ticketService.activateTicket(code, userId);
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Redeem failed' });
  }
};

export const getMyTickets = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const drawId = req.query.draw_id;
    const role = req.user!.role;
    const locationId = req.user!.location_id;

    let result;
    if (role === 'Business') {
      if (locationId) {
        result = await ticketService.getLocationTicketsService(userId, Number(drawId));
      } else {
        result = await ticketService.getBusinessTicketsService(userId, Number(drawId));
      }
    } else {
      result = await ticketService.getUserTicketsService(userId, Number(drawId));
    }
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Failed to get tickets' });
  }
};

export const getStatus = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = await ticketService.checkFreeTicketEligibility(userId);
    res.json(status);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Error checking status' });
  }
};

export const activate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await ticketService.activateFreeTicket(userId);
    res.status(201).json(result);
  } catch (error: unknown) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Activation failed' });
  }
};

export const generateTicket = async (req: AuthRequest, res: Response) => {
  try {
    const user_id = req.user!.id;
    let location_id: number | undefined = req.body?.location_id ?? req.user!.location_id ?? undefined;

    if (!location_id) {
      const businessLocations = await getBusinessLocationsByUserId(user_id);

      if (!businessLocations || businessLocations.length === 0) {
        res.status(400).json({
          message: 'No locations found for this business. A location is required to issue a ticket.',
        });
        return;
      }

      location_id = businessLocations[0].id;
    }

    const result = await ticketService.generateTicketService(user_id, Number(location_id));

    res.status(201).json({ success: true, code: result.code });
  } catch (error: unknown) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to generate ticket' });
  }
};
