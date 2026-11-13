-- Disposable CI database only. Executed by the migration owner after 001-005.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO agents (id, agent_key, display_name, status)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'p2-check-a', 'P2 A', 'active'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'p2-check-b', 'P2 B', 'active');
INSERT INTO agent_versions (id, agent_id, version_number, foundry_project_endpoint,
  foundry_agent_name, foundry_agent_version, published_at)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaabbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1,
   'https://example.invalid/api/projects/poc', 'sara', '1', now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbcccc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1,
   'https://example.invalid/api/projects/poc', 'sara', '1', now());
UPDATE agents SET active_version_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaabbbb'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE agents SET active_version_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbcccc'
WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
INSERT INTO guest_sessions (id, agent_id, token_hash, expires_at)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p2test-a',now()+interval '1 hour'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','p2test-b',now()+interval '1 hour');
INSERT INTO tickets (id, agent_id, agent_version_id, guest_session_id)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaabbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbcccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001');
COMMIT;
