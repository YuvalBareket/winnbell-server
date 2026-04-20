-- Migration 003: Switch all businesses to receipt-based entry mode (v2)
-- Run AFTER 001 and 002 have been applied.

UPDATE business SET entry_mode = 'receipt';
