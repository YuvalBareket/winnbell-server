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
  getLocationProfileById,
  getParticipatingLocationById,
  removeManager,
  searchParticipatingLocations,
  setupBusiness,
  updateBusiness,
  updateCampaignSettingsController,
  updateLocation,
  updateLogo,
} from './business.controller.js';
import { getBusinessAnalytics } from './businessAnalytics.controller.js';
import { getCampaignHeaderController, getCampaignKpisController, getCampaignEntriesController, getCampaignsController } from './activity.controller.js';
import { createCheckout, verifySession, getSubscription, cancelSub, resumeSub, getFoundingAvailability, updatePlan, getInvoices } from '../stripe/stripe.controller.js';

const router = Router();

// ── Public routes (no auth required) — these are also mounted in app.ts BEFORE authenticateToken ──
router.get('/nearby', getNearby);
router.get('/participating', getParticipating);
router.get('/participating/locations/search', searchParticipatingLocations);
router.get('/locations/:locationId/profile', getLocationProfileById);
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
router.get('/analytics/:category', requireRole('Business'), getBusinessAnalytics);
router.get('/campaign/list', requireRole('Business'), getCampaignsController);
router.get('/campaign/header', requireRole('Business'), getCampaignHeaderController);
router.get('/campaign/kpis', requireRole('Business'), getCampaignKpisController);
router.get('/campaign/entries', requireRole('Business'), getCampaignEntriesController);
router.post('/subscription/checkout', requireRole('Business'), createCheckout);
router.post('/subscription/verify-session', requireRole('Business'), verifySession);
router.get('/subscription', requireRole('Business'), getSubscription);
router.post('/subscription/cancel', requireRole('Business'), cancelSub);
router.post('/subscription/resume', requireRole('Business'), resumeSub);
router.put('/subscription/plan', requireRole('Business'), updatePlan);
router.get('/subscription/invoices', requireRole('Business'), getInvoices);

export default router;
