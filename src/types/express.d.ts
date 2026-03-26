import { UserPayload } from '../shared/middleware/auth.middleware';

declare global {
  namespace Express {
    interface Request {
      user: UserPayload;
    }
  }
}

export {};
