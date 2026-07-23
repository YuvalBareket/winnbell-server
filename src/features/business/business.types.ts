// src/features/business/business.types.ts

export interface INearbyQuery {
  minLat: string;
  maxLat: string;
  minLng: string;
  maxLng: string;
  sector?: string;
  limit?: string;
  name?: string;
}

/** Shape returned by the nearby search query */
export interface NearbyBusiness {
  location_id: number;
  address: string;
  latitude: number;
  longitude: number;
  id: number;
  name: string;
  sector: string;
  logo_url: string | null;
}

/** Shape of each location in the FOR JSON subquery inside getMyBusinessData */
export interface MyBusinessLocation {
  id: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  suite: string | null;
  phone: string | null;
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
  logo_url: string | null;
  receipt_example_image_url: string | null;
  is_subscribed: boolean;
  entries_per_location: number | null;   // from subscription; NULL = falls back to global cap
  min_transaction_amount: number | null; // NULL = no minimum
  global_entry_cap: number | null;       // platform ceiling set by admin
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  // Enrolled in the currently Open campaign - gates the pre-save "campaign is live"
  // warning while editing the receipt minimum (audit P2-10).
  is_participating: boolean;
  locations: MyBusinessLocation[];
  website_url?: string | null;
}

export interface UpdateCampaignSettingsInput {
  min_transaction_amount?: number; // optional — only present when the threshold is being changed
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
  latitude: number;
  longitude: number;
  business_id: number;
  business_name: string;
  sector: string;
  logo_url: string | null;
  min_transaction_amount: number | null;
  pending_min_transaction_amount: number | null;
  receipt_example_image_url: string | null;
  description: string;
  terms_text: string;
  phone: string | null;
  website_url: string | null;
  other_locations: Array<{ id: number; name: string; address: string }>;
  cap_reached?: boolean;
  draw_prize_amount?: number | null;
  draw_date?: string | null;
  // active location + active subscription + enrolled in the current open draw. Gates the submit button.
  is_participating?: boolean;
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
  suite?: string;
  phone?: string;
}

export interface BusinessSetupInput {
  businessName: string;
  businessSector: string;
  description: string;
  // Registered legal entity name, captured on the business register page and carried
  // through email-verify -> setup. Admin-facing only.
  legal_name?: string | null;
  website_url?: string;
  logo_url?: string;
  locations: LocationInput[];
  min_transaction_amount: number | null;
}

export interface UpdateLocationInput {
  name: string;
  address: string;
  lat: number;
  lon: number;
  suite?: string | null;
  phone?: string | null;
}

export interface UpdateBusinessInput {
  businessName: string;
  businessSector: string;
  description: string;
  legal_name?: string | null;
  terms_text: string;
  website_url?: string | null;
}

export interface AddLocationInput {
  name: string;
  address: string;
  lat: number;
  lon: number;
  suite?: string | null;
  phone?: string | null;
}
