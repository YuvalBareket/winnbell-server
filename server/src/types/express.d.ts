import { UserPayload } from './auth'; // Or wherever your User interface is defined

declare global {
  namespace Express {
    interface Request {
      user: UserPayload;
    }
  }
}

export {};
