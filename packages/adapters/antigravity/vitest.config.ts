import { unitProject } from '../../../vitest.shared.ts';

// The doctor and the hook tests start the launcher and the MCP server as Antigravity would.
export default unitProject('@friday/adapter-antigravity', { testTimeout: 60_000 });
