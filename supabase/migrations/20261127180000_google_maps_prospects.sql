-- =============================================================================
-- Phase 2A — prospects from Google Maps.
--
-- A business found on Google Maps becomes a client only when a member chooses
-- to add it. We keep its Google place id so the same place cannot be added
-- twice and its details can be refreshed from Google later.
-- =============================================================================

alter table public.companies drop constraint companies_source_check;
alter table public.companies add constraint companies_source_check
  check (source in ('manual', 'import', 'referral', 'website', 'event', 'google_maps', 'other'));

create unique index companies_unique_google_place
  on public.companies (workspace_id, (attributes ->> 'google_place_id'))
  where attributes ? 'google_place_id';
