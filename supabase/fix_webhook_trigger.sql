-- =========================================================================
-- ZEN SPLIT DATABASE TRIGGER FIX
-- Run this script in the Supabase SQL Editor (SQL Editor -> New Query -> Run)
-- =========================================================================

-- Option 1: Drop the crashing webhook trigger (Recommended)
-- Since the React Native app calculates and inserts simplified debts client-side,
-- the trigger that attempts to contact the edge function is redundant and is causing
-- inserts to fail when edge function URLs are not configured.
DROP TRIGGER IF EXISTS on_transaction_splits_change ON public.transaction_splits;

-- Option 2: Make the trigger function safe against null settings (Backup)
-- In case the trigger is recreated or required in the future, this safe function 
-- will only execute net.http_post if the edge_function_url setting is defined.
CREATE OR REPLACE FUNCTION notify_simplify_debts()
RETURNS TRIGGER AS $$
DECLARE
  url_setting TEXT;
  service_role_key TEXT;
BEGIN
  url_setting := current_setting('app.settings.edge_function_url', true);
  service_role_key := current_setting('app.settings.service_role_key', true);
  
  -- Only attempt to call net.http_post if the URL is configured and not null
  IF url_setting IS NOT NULL AND url_setting <> '' AND service_role_key IS NOT NULL AND service_role_key <> '' THEN
    PERFORM net.http_post(
      url := url_setting || '/simplify_debts',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || service_role_key),
      body := jsonb_build_object('record', row_to_json(NEW))
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
