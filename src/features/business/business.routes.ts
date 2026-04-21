// src/features/business/business.routes.ts
import { Router } from 'express';
import { authenticateToken, requireRole } from '../../shared/middleware/auth.middleware.js';
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
  removeManager,
  searchParticipatingLocations,
  setupBusiness,
  updateBusiness,
  updateCampaignSettingsController,
  updateLocation,
  updateLogo,
} from './business.controller.js';
import { getStats } from './stats.controller.js';
import { createCheckout, verifySession, getSubscription, cancelSub, resumeSub } from '../stripe/stripe.controller.js';

const router = Router();

// ── Public routes (no auth required) — these are also mounted in app.ts BEFORE authenticateToken ──
router.get('/nearby', getNearby);
router.get('/participating', getParticipating);
router.get('/participating/locations/search', searchParticipatingLocations);
router.get('/mode', getEntryMode);
router.post('/address', getAddressController);

// ── Authenticated routes ──
// /setup requires the user to already have role 'Business' (assigned at registration via invite or sign-up flow)
router.post('/setup', requireRole('Business'), setupBusiness);
router.get('/my-business', authenticateToken, getMyBusiness);
router.patch('/', authenticateToken, updateBusiness);
router.patch('/campaign-settings', authenticateToken, updateCampaignSettingsController);
router.get('/upload-url', authenticateToken, getUploadUrl);
router.patch('/logo', authenticateToken, updateLogo);
router.post('/locations', authenticateToken, addLocation);
router.patch('/locations/:locationId', authenticateToken, updateLocation);
router.delete('/locations/:locationId', authenticateToken, deleteLocation);
router.post('/locations/:locationId/invite', authenticateToken, createInviteLink);
router.delete('/locations/:locationId/manager', authenticateToken, removeManager);
router.get('/stats', authenticateToken, requireRole('Business', 'Admin'), getStats);
router.post('/subscription/checkout', requireRole('Business'), createCheckout);
router.post('/subscription/verify-session', requireRole('Business'), verifySession);
router.get('/subscription', requireRole('Business'), getSubscription);
router.post('/subscription/cancel', requireRole('Business'), cancelSub);
router.post('/subscription/resume', requireRole('Business'), resumeSub);

export default router;
