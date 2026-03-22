// src/features/business/business.types.ts

export interface INearbyQuery {
  latitude: string;
  longitude: string;
  radius?: string; // in Kilometers
}

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
type GeoapifyResult = {
  formatted: string;
  lat: number;
  long: number;
  [key: string]: any;
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
  businessSector: string;
  description: string;
  locations: LocationInput[];
  terms_text: string;
}
