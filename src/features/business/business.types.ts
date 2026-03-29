// src/features/business/business.types.ts

export interface INearbyQuery {
  latitude: string;
  longitude: string;
  radius?: string; // in Kilometers
}

/** Shape returned by the nearby search query */
export interface NearbyBusiness {
  location_id: number;
  address: string;
  latitude: number;
  longitude: number;
  id: number;
  description: string;
  terms_text: string;
  name: string;
  sector: string;
  logo_url: string | null;
  distance_km: number;
}

/** Shape of each location in the FOR JSON subquery inside getMyBusinessData */
export interface MyBusinessLocation {
  id: number;
  name: string;
  address: string;
  manager_id: number | null;
  manager_name: string | null;
  is_active: boolean;
}

/** Shape returned by getMyBusinessData */
export interface MyBusinessData {
  id: number;
  name: string;
  sector: string;
  description: string;
  terms_text: string;
  subscription_status: string | null;
  monthly_fee: number | null;
  next_billing_date: string | null;
  locations: MyBusinessLocation[];
}

/** @deprecated Use NearbyBusiness instead */
export interface IBusinessLocation {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  distance_km: number;
  sector: string;
  location: string;
  logo_url?: string;
}

export type AddressSuggestion = {
  label: string;
  lat: number;
  lon: number;
};
export type GeoapifyResult = {
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  name?: string;
  lat: number;
  lon: number;
  rank?: { confidence?: number; importance?: number };
  [key: string]: unknown;
};

export type GeoapifyResponse = {
  results?: GeoapifyResult[];
};

// src/features/business/types/business.types.ts
export interface LocationInput {
  name: string;
  address: string;
  lat: number | null;
  lon: number | null;
}

export interface BusinessSetupInput {
  businessName: string;
  businessSector: string;
  description: string;
  locations: LocationInput[];
  terms_text: string;
}

export interface UpdateLocationInput {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export interface UpdateBusinessInput {
  businessSector: string;
  description: string;
  terms_text: string;
}

export interface AddLocationInput {
  name: string;
  address: string;
  lat: number;
  lon: number;
}
