-- Meyora Field Service Conversational Demo / PostgreSQL schema v1.1
-- Static demo snapshot. No simulator engine or scheduled-event worker is required.
-- Public-real account/contact identities may be present; service/comms/commercial events are synthetic demo data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS demo_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS products (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS skills (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS territories (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS employees (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS account_assignments (id text PRIMARY KEY, data jsonb NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (id text PRIMARY KEY, account_id text, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE TABLE IF NOT EXISTS opportunities (id text PRIMARY KEY, account_id text, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);
CREATE TABLE IF NOT EXISTS opportunity_contact_roles (
  id text PRIMARY KEY,
  opportunity_id text,
  contact_id text,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_events (
  id text PRIMARY KEY,
  opportunity_id text,
  contact_id text,
  start_at timestamp,
  end_at timestamp,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_events_start ON crm_events(start_at);
CREATE TABLE IF NOT EXISTS crm_tasks (
  id text PRIMARY KEY,
  opportunity_id text,
  contact_id text,
  activity_date date,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (id text PRIMARY KEY, account_id text, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sites_account ON sites(account_id);
CREATE TABLE IF NOT EXISTS contact_site_links (
  id text PRIMARY KEY,
  site_id text,
  account_id text,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  account_id text,
  site_id text,
  health_status text,
  lifecycle_status text,
  next_pm_due date,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_account ON assets(account_id);
CREATE INDEX IF NOT EXISTS idx_assets_site ON assets(site_id);
CREATE INDEX IF NOT EXISTS idx_assets_health ON assets(health_status);
CREATE TABLE IF NOT EXISTS asset_relationships (
  id text PRIMARY KEY,
  from_asset_id text,
  to_asset_id text,
  relationship_type text,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id text PRIMARY KEY,
  account_id text,
  asset_id text,
  opened_at timestamp,
  closed_at timestamp,
  priority text,
  status text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_account ON cases(account_id);
CREATE INDEX IF NOT EXISTS idx_cases_asset ON cases(asset_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

CREATE TABLE IF NOT EXISTS work_orders (
  id text PRIMARY KEY,
  account_id text,
  site_id text,
  asset_id text,
  case_id text,
  contact_id text,
  assigned_engineer_id text,
  scheduled_start timestamp,
  scheduled_end timestamp,
  priority text,
  status text,
  work_type text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wo_engineer_start ON work_orders(assigned_engineer_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_wo_account ON work_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_wo_asset ON work_orders(asset_id);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);

CREATE TABLE IF NOT EXISTS service_appointments (
  id text PRIMARY KEY,
  work_order_id text,
  engineer_id text,
  site_id text,
  start_at timestamp,
  end_at timestamp,
  status text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_appt_start ON service_appointments(start_at);
CREATE INDEX IF NOT EXISTS idx_service_appt_engineer ON service_appointments(engineer_id, start_at);

CREATE TABLE IF NOT EXISTS service_tasks (
  id text PRIMARY KEY,
  work_order_id text,
  status text,
  sequence integer,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_tasks_wo ON service_tasks(work_order_id);

CREATE TABLE IF NOT EXISTS measurements (
  id text PRIMARY KEY,
  work_order_id text,
  asset_id text,
  recorded_at timestamp,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_measurements_wo ON measurements(work_order_id, recorded_at);

CREATE TABLE IF NOT EXISTS service_notes (
  id text PRIMARY KEY,
  work_order_id text,
  author_employee_id text,
  created_at timestamp,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_notes_wo ON service_notes(work_order_id, created_at);

CREATE TABLE IF NOT EXISTS parts (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS inventory_locations (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS inventory_stock (
  location_id text,
  part_id text,
  quantity_on_hand integer,
  quantity_reserved integer,
  data jsonb NOT NULL,
  PRIMARY KEY(location_id, part_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_part ON inventory_stock(part_id);
CREATE TABLE IF NOT EXISTS part_reservations (
  id text PRIMARY KEY,
  work_order_id text,
  part_id text,
  location_id text,
  status text,
  needed_by timestamp,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_wo ON part_reservations(work_order_id);
CREATE TABLE IF NOT EXISTS part_movements (
  id text PRIMARY KEY,
  work_order_id text,
  part_id text,
  occurred_at timestamp,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_part_movements_wo ON part_movements(work_order_id, occurred_at);

CREATE TABLE IF NOT EXISTS identity_directory (
  id text PRIMARY KEY,
  display_name text,
  person_type text,
  email text,
  teams_user_id text,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS email_threads (
  id text PRIMARY KEY,
  account_id text,
  asset_id text,
  work_order_id text,
  opportunity_id text,
  subject text,
  status text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_threads_wo ON email_threads(work_order_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_account ON email_threads(account_id);

CREATE TABLE IF NOT EXISTS emails (
  id text PRIMARY KEY,
  thread_id text,
  direction text,
  sender text,
  sent_at timestamp,
  received_at timestamp,
  status text,
  is_read boolean,
  flagged boolean,
  account_id text,
  asset_id text,
  work_order_id text,
  subject text,
  body_text text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_thread_time ON emails(thread_id, COALESCE(received_at, sent_at));
CREATE INDEX IF NOT EXISTS idx_emails_unread ON emails(is_read, COALESCE(received_at, sent_at));
CREATE INDEX IF NOT EXISTS idx_emails_wo ON emails(work_order_id);
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);

CREATE TABLE IF NOT EXISTS email_attachments (
  id text PRIMARY KEY,
  thread_id text,
  email_id text,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS teams_channels (id text PRIMARY KEY, name text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS teams_conversations (
  id text PRIMARY KEY,
  channel_id text,
  conversation_type text,
  title text,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS teams_messages (
  id text PRIMARY KEY,
  conversation_id text,
  channel_id text,
  sender_person_id text,
  sent_at timestamp,
  is_read boolean,
  status text,
  work_order_id text,
  asset_id text,
  body_text text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_conv_time ON teams_messages(conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_teams_unread ON teams_messages(is_read, sent_at);
CREATE INDEX IF NOT EXISTS idx_teams_wo ON teams_messages(work_order_id);

CREATE TABLE IF NOT EXISTS meetings (
  id text PRIMARY KEY,
  start_at timestamp,
  end_at timestamp,
  work_order_id text,
  account_id text,
  status text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_at);
CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id text,
  person_id text,
  role text,
  attendance text,
  data jsonb NOT NULL,
  PRIMARY KEY(meeting_id, person_id)
);
CREATE TABLE IF NOT EXISTS meeting_transcripts (
  id text PRIMARY KEY,
  meeting_id text,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id text PRIMARY KEY,
  source text,
  event_type text,
  start_at timestamp,
  end_at timestamp,
  status text,
  work_order_id text,
  meeting_id text,
  account_id text,
  subject text,
  location text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_time ON calendar_events(start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_calendar_wo ON calendar_events(work_order_id);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  created_at timestamp,
  source text,
  severity text,
  status text,
  account_id text,
  asset_id text,
  work_order_id text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_status_time ON notifications(status, created_at);

CREATE TABLE IF NOT EXISTS signals (
  id text PRIMARY KEY,
  created_at timestamp,
  signal_type text,
  status text,
  account_id text,
  asset_id text,
  work_order_id text,
  opportunity_id text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_account ON signals(account_id, created_at);

CREATE TABLE IF NOT EXISTS timeline_events (
  id text PRIMARY KEY,
  occurred_at timestamp,
  event_type text,
  source text,
  account_id text,
  asset_id text,
  work_order_id text,
  source_record_id text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_account_time ON timeline_events(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_timeline_wo_time ON timeline_events(work_order_id, occurred_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id text,
  action text NOT NULL,
  object_type text,
  object_id text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb
);

CREATE OR REPLACE VIEW v_maya_work_orders AS
SELECT * FROM work_orders WHERE assigned_engineer_id = 'emp_maya_iyer';

CREATE OR REPLACE VIEW v_unread_emails AS
SELECT * FROM emails WHERE is_read = false AND status <> 'draft';

CREATE OR REPLACE VIEW v_unread_teams_messages AS
SELECT * FROM teams_messages WHERE is_read = false;
