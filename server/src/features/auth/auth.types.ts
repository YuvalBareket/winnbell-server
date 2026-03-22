// This matches your SQL table 'user'
export interface User {
  id: number;
  full_name: string;
  email: string;
  password_hash: string;
  role: 'User' | 'Business';
  zip_code?: string;
  created_at: Date;
}

// This matches the data coming from the Frontend Register form
export interface RegisterRequest {
  fullName: string;
  email: string;
  password: string;
  role: string;
  inviteToken?: string;
}

// This is the response we send back
export interface AuthResponse {
  message: string;
  token?: string; // We will add this later for Login
  user?: {
    id: number;
    email: string;
    fullName: string;
    role: string;
  };
}
