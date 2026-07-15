import { Router } from 'express';
import { submitContactMessage } from './contact.controller.js';

const router = Router();

// Public - logged-out visitors can contact us too. Rate-limited in app.ts.
router.post('/', submitContactMessage);

export default router;
