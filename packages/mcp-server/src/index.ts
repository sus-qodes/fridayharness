/**
 * @friday/mcp-server
 * The `friday` stdio MCP server: tools, resources and prompts for attached harnesses.
 */
export const PACKAGE_NAME = '@friday/mcp-server';

export { SERVER_INSTRUCTIONS } from './instructions.js';
export { createFridayMcpServer } from './server.js';
export {
  FridaySession,
  type MeView,
  resolveAgentKey,
  SESSION_HOSTS,
  type SessionOptions,
  type SessionVendor,
  sessionVendor,
} from './session.js';
export {
  callTool,
  createToolServer,
  SPAWNED_AGENT_TOOLS,
  type SpawnedAgentTool,
  spawnedAgentTools,
  spawnedAgentToolsFor,
  spawnedToolsRule,
  toolInputSchema,
} from './spawned.js';
export { createFridayTools, type FridayTool, type HostUi, type ToolResult } from './tools.js';
