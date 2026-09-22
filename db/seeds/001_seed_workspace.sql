-- Development seed workspace. Its id MUST match
-- bff/src/config/index.ts -> auth.devSeedWorkspaceId default
-- (00000000-0000-0000-0000-0000000000a1), so DevAuthContextProvider's
-- default RequestContext points at a workspace that actually exists.

INSERT INTO workspaces (id, name)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'Dev Seed Workspace')
ON CONFLICT (id) DO NOTHING;
