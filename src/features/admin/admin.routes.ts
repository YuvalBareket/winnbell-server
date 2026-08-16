import { Router } from 'express';
import * as adminController from './admin.controller.js';
import {
  adminGetCampaignList,
  adminGetCampaignHeader,
  adminGetCampaignKpis,
  adminGetCampaignEntries,
  adminGetBusinessAnalytics,
} from './adminBusinessView.controller.js';
import { getFunnelAnalytics } from './adminFunnel.controller.js';
import { requireRole } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.use(requireRole('Admin'));

router.get('/overview', adminController.getOverview);
router.get('/funnel', getFunnelAnalytics);
router.get('/businesses', adminController.getDashboardData);
// health-summary MUST be registered before /businesses/:businessId so the literal
// string 'health-summary' is never captured as a businessId param (Express 5 matches
// routes in registration order).
router.get('/businesses/health-summary', adminController.getBusinessHealthSummary);
router.get('/draws', adminController.getDraws);
router.get('/draws-all', adminController.getAllDraws);
router.get('/users', adminController.getUsers);
// analytics-summary MUST be registered before /users/:userId so the literal string
// 'analytics-summary' is never captured as a userId param (Express 5 matches routes
// in registration order, identical to the /businesses/health-summary guard above).
router.get('/users/analytics-summary', adminController.getUserAnalytics);
router.get('/users/:userId', adminController.getUserDetail);
router.get('/businesses/:businessId', adminController.getBusinessDetail);
router.get('/businesses/:businessId/entries', adminController.getBusinessEntries);
router.get('/businesses/:businessId/campaign/list', adminGetCampaignList);
router.get('/businesses/:businessId/campaign/header', adminGetCampaignHeader);
router.get('/businesses/:businessId/campaign/kpis', adminGetCampaignKpis);
router.get('/businesses/:businessId/campaign/entries', adminGetCampaignEntries);
router.get('/businesses/:businessId/analytics/:category', adminGetBusinessAnalytics);
router.patch('/users/:userId/role', adminController.updateUserRole);
router.patch('/users/:userId/active', adminController.toggleUserActive);
router.patch('/users/:userId/risk', adminController.setUserRisk);
router.post('/business', adminController.createBusiness);
router.post('/draw', adminController.createDraw);
router.patch('/draws/:drawId', adminController.updateDraw);
router.patch('/draws/:drawId/prize-reveal', adminController.setDrawPrizeRevealed);
router.delete('/draws/:drawId', adminController.deleteDraw);
router.post('/draws/:drawId/duplicate', adminController.duplicateDraw);
router.post('/draws/:drawId/open', adminController.openDraw);
router.post('/draws/:drawId/close', adminController.closeDraw);
router.post('/draws/:drawId/pick-winner', adminController.pickWinner);
router.post('/draws/:drawId/extend-order', adminController.extendDrawWinnerOrder);
router.post('/draws/:drawId/confirm-winner', adminController.confirmWinner);
router.post('/draws/:drawId/reopen', adminController.reopenDraw);
router.get('/draws/:drawId/businesses', adminController.getDrawBusinesses);
router.post('/draws/:drawId/businesses/:businessId', adminController.addBusinessToDraw);
router.delete('/draws/:drawId/businesses/:businessId', adminController.removeBusinessFromDraw);
router.patch('/draws/:drawId/businesses/:businessId/participation', adminController.patchBusinessParticipation);
router.get('/draws/:drawId/candidate', adminController.getDrawCandidate);
router.get('/draws/:drawId/rejected-winners', adminController.getDrawRejectedWinners);
router.get('/draws/:drawId/winner-order', adminController.getDrawWinnerOrder);
router.get('/draws/:drawId/audit-log', adminController.getDrawAuditLog);
router.get('/draws/:drawId/rules-pdf', adminController.downloadDrawRulesPdf);
router.get('/locations-map', adminController.getAdminMapLocations);
router.get('/settings', adminController.getPlatformSettings);
router.patch('/settings', adminController.updatePlatformSettings);

router.get('/promo-codes', adminController.getPromoCodes);
router.post('/promo-codes', adminController.createPromoCode);
router.patch('/promo-codes/:id/deactivate', adminController.deactivatePromoCode);

router.post('/notifications/send', adminController.sendNotification);
router.get('/notifications/history', adminController.getNotificationHistory);

router.patch('/tickets/:ticketId/image-decision', adminController.adminImageDecision);
router.get('/analytics', adminController.getAnalytics);
router.get('/analytics/growth', adminController.getGrowth);
router.get('/analytics/entry-volume', adminController.getEntryVolume);
router.get('/analytics/campaigns', adminController.getCampaignComparison);
router.get('/analytics/locations', adminController.getLocationBreakdown);

export default router;
