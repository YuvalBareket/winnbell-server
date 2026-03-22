// src/features/business/business.controller.ts
import { Request, Response } from 'express';
import { INearbyQuery } from './business.types.js';
import {
  createFullBusinessProfile,
  createManagerInviteLink,
  getAddress,
  getMyBusinessData,
  getNearbyBusinessesService,
} from './business.service.js';

export const getNearby = async (
  req: Request<{}, {}, {}, INearbyQuery>,
  res: Response,
) => {
  try {
    const { latitude, longitude, radius } = req.query;

    if (!latitude || !longitude) {
      return res
        .status(400)
        .json({ message: 'Latitude and Longitude are required' });
    }

    const businesses = await getNearbyBusinessesService(
      parseFloat(latitude),
      parseFloat(longitude),
      radius ? parseFloat(radius) : 10,
    );

    res.json(businesses);
  } catch (error) {
    console.error('Nearby Controller Error:', error);
    res.status(500).json({ message: 'Failed to fetch nearby businesses' });
  }
};
export const getAddressController = async (req: Request, res: Response) => {
  try {
    const text = String(req.query.q || '').trim();
    const data = await getAddress(text);
    res.json(data);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};
export const setupBusiness = async (req: Request, res: Response) => {
  try {
    // req.user is populated by your protect/auth middleware
    const userId = (req as any).user.id;
    const result = await createFullBusinessProfile(
      userId,

      req.body,
    );

    res.status(201).json({
      success: true,
      message: 'Business profile and locations created successfully',
      businessId: result.businessId,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message || 'Internal Server Error' });
  }
};
export const getMyBusiness = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id; // Populated by authenticateToken
    const business = await getMyBusinessData(userId);

    if (!business) {
      return res.status(404).json({ message: 'Business profile not found' });
    }

    res.json(business);
  } catch (error: any) {
    res.status(500).json({ message: error.message || 'Internal Server Error' });
  }
};
export const createInviteLink = async (req: Request, res: Response) => {
  try {
    const { locationId } = req.params;

    // 1. Generate the secure token
    const inviteLink = await createManagerInviteLink(
      Number(locationId),
      req.user?.id,
    );

    res.json({ inviteLink });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to generate invite link' });
  }
};
