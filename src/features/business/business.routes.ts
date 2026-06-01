// src/features/business/business.routes.ts
import { Router } from 'express';
import { requireRole } from '../../shared/middleware/auth.middleware.js';
import {
  addLocation,
  createInviteLink,
  deleteLocation,
  getAddressController,
  getEntryMode,
  getMyBusiness,
  getNearby,
  getParticipating,
  getUploadUrl,
  getParticipatingLocationById,
  removeManager,
  searchParticipatingLocations,
  setupBusiness,
  updateBusiness,
  updateCampaignSettingsController,
  updateLocation,
  updateLogo,
} from './business.controller.js';
import { getStats } from './stats.controller.js';
import { getActivity, qualifyTicket } from './activity.controller.js';
import { createCheckout, verifySession, getSubscription, cancelSub, resumeSub, getFoundingAvailability, updatePlan } from '../stripe/stripe.controller.js';

const router = Router();

// ── Public routes (no auth required) — these are also mounted in app.ts BEFORE authenticateToken ──
router.get('/nearby', getNearby);
router.get('/participating', getParticipating);
router.get('/participating/locations/search', searchParticipatingLocations);
router.get('/participating/locations/:locationId', getParticipatingLocationById);
router.get('/mode', getEntryMode);
// /address is handled by publicBusinessRouter in app.ts with rate limiter
router.get('/subscription/founding-availability', getFoundingAvailability);

// ── Authenticated routes ──
// /setup requires the user to already have role 'Business' (assigned at registration via invite or sign-up flow)
router.post('/setup', requireRole('Business'), setupBusiness);
router.get('/my-business', getMyBusiness);
router.patch('/', requireRole('Business'), updateBusiness);
router.patch('/campaign-settings', requireRole('Business'), updateCampaignSettingsController);
router.get('/upload-url', requireRole('Business'), getUploadUrl);
router.patch('/logo', requireRole('Business'), updateLogo);
router.post('/locations', requireRole('Business'), addLocation);
router.patch('/locations/:locationId', requireRole('Business'), updateLocation);
router.delete('/locations/:locationId', requireRole('Business'), deleteLocation);
router.post('/locations/:locationId/invite', requireRole('Business'), createInviteLink);
router.delete('/locations/:locationId/manager', requireRole('Business'), removeManager);
router.get('/stats', requireRole('Business'), getStats);
router.get('/activity', requireRole('Business'), getActivity);
router.patch('/tickets/:ticketId/qualify', requireRole('Business'), qualifyTicket);
router.post('/subscription/checkout', requireRole('Business'), createCheckout);
router.post('/subscription/verify-session', requireRole('Business'), verifySession);
router.get('/subscription', requireRole('Business'), getSubscription);
router.post('/subscription/cancel', requireRole('Business'), cancelSub);
router.post('/subscription/resume', requireRole('Business'), resumeSub);
router.put('/subscription/plan', requireRole('Business'), updatePlan);

export default router;
