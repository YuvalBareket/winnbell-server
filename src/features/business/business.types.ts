// src/features/business/business.types.ts

export interface INearbyQuery {
  minLat: string;
  maxLat: string;
  minLng: string;
  maxLng: string;
  sector?: string;
  limit?: string;
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
  receipt_example_image_url: string | null;
  min_transaction_amount: number | null;
  distance_km: number;
  website_url?: string | null;
  phone?: string | null;
  other_locations?: Array<{id: number; name: string; address: string}>;
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

// Entry mode controls how customers submit entries for this business.
// 'code'    = MVP: business generates codes, customers activate them
// 'receipt' = v2: customers self-submit receipt identifier + amount
export type EntryMode = 'code' | 'receipt';

/** Shape returned by getMyBusinessData */
export interface MyBusinessData {
  id: number;
  name: string;
  sector: string;
  description: string;
  terms_text: string;
  logo_url: string | null;
  receipt_example_image_url: string | null;
  is_subscribed: boolean;
  is_participating: boolean;
  entry_mode: EntryMode;
  entry_cap: number | null;              // NULL = falls back to global cap
  min_transaction_amount: number | null; // NULL = no minimum
  global_entry_cap: number | null;       // platform ceiling set by admin
  subscription_status: string | null;
  monthly_fee: number | null;
  next_billing_date: string | null;
  locations: MyBusinessLocation[];
  website_url?: string | null;
  phone?: string | null;
}

export interface UpdateCampaignSettingsInput {
  min_transaction_amount: number | null;
  receipt_example_image_url?: string | null;
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

/** Flat location row returned by getAllParticipatingLocationsService */
export interface ParticipatingLocation {
  location_id: number;
  location_name: string;
  address: string;
  business_id: number;
  business_name: string;
  sector: string;
  logo_url: string | null;
  min_transaction_amount: number | null;
  receipt_example_image_url: string | null;
}

export type AddressSuggestion = {
  label: string;
  lat: number;
  lon: number;
};

// Google Places API (New) — Text Search response types
type GooglePlaceLocation = { latitude: number; longitude: number };
type GooglePlaceDisplayName = { text: string; languageCode?: string };
export type GooglePlaceResult = {
  formattedAddress?: string;
  location?: GooglePlaceLocation;
  displayName?: GooglePlaceDisplayName;
};
export type GooglePlacesResponse = {
  places?: GooglePlaceResult[];
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
  min_transaction_amount: number | null;
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
  website_url?: string | null;
  phone?: string | null;
}

export interface AddLocationInput {
  name: string;
  address: string;
  lat: number;
  lon: number;
}
