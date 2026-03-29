// src/features/business/business.controller.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { INearbyQuery } from './business.types.js';
import {
  addBusinessLocation,
  createFullBusinessProfile,
  createManagerInviteLink,
  deleteBusinessLocation,
  getAddress,
  getMyBusinessData,
  getNearbyBusinessesService,
  updateBusinessLocation,
  updateBusinessProfile,
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Bad request';
    res.status(400).json({ message });
  }
};
export const setupBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const result = await createFullBusinessProfile(userId, req.body);

    res.status(201).json({
      success: true,
      message: 'Business profile and locations created successfully',
      businessId: result.businessId,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    res.status(500).json({ message });
  }
};

export const getMyBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const business = await getMyBusinessData(userId);

    if (!business) {
      res.status(404).json({ message: 'Business profile not found' });
      return;
    }

    res.json(business);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    res.status(500).json({ message });
  }
};

export const updateBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { businessSector, description, terms_text } = req.body as {
      businessSector: string;
      description: string;
      terms_text: string;
    };

    await updateBusinessProfile(req.user!.id, { businessSector, description, terms_text });
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'BUSINESS_NOT_FOUND') {
      res.status(404).json({ message: 'Business not found' });
      return;
    }
    res.status(500).json({ message: 'Failed to update business' });
  }
};

export const updateLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { locationId } = req.params;
    const { name, address, lat, lon } = req.body as {
      name: string;
      address: string;
      lat: number;
      lon: number;
    };

    await updateBusinessLocation(Number(locationId), req.user!.id, {
      name,
      address,
      lat,
      lon,
    });

    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    res.status(500).json({ message: 'Failed to update location' });
  }
};

export const addLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { name, address, lat, lon } = req.body as {
      name: string;
      address: string;
      lat: number;
      lon: number;
    };

    const result = await addBusinessLocation(userId, { name, address, lat, lon });
    res.status(201).json({ locationId: result.locationId });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'BUSINESS_NOT_FOUND') {
      res.status(404).json({ message: 'Business not found' });
      return;
    }
    res.status(500).json({ message: 'Failed to add location' });
  }
};

export const deleteLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { locationId } = req.params;
    await deleteBusinessLocation(Number(locationId), req.user!.id);
    res.status(200).json({ success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    res.status(500).json({ message: 'Failed to delete location' });
  }
};

export const createInviteLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { locationId } = req.params;

    const inviteLink = await createManagerInviteLink(
      Number(locationId),
      req.user!.id,
    );

    res.json({ inviteLink });
  } catch (error: unknown) {
    res.status(500).json({ message: 'Failed to generate invite link' });
  }
};
