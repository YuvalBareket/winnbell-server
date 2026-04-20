-- Migration 006: add min_transaction_amount to business table
ALTER TABLE business ADD COLUMN IF NOT EXISTS min_transaction_amount NUMERIC(10,2) NULL;
