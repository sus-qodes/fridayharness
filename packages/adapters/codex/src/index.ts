/**
 * @friday/adapter-codex
 * Codex as a Friday spawn harness (ADR-0032): its own `codex app-server` per run attempt inside a
 * Friday process group, one thread per attempt, approvals answered through Friday's policy.
 */
export const PACKAGE_NAME = '@friday/adapter-codex';

export {
  CODEX_RULES,
  CodexAdapter,
  type CodexAdapterOptions,
  type CodexSandbox,
  codexHostUsage,
  codexRules,
  FINAL_SCHEMA,
  parseFinal,
  STRICT_FINAL_SCHEMA,
} from './adapter.js';
export { type CodexInstall, findCodex, hostEnvironment } from './detect.js';
export { type CodexDoctorCheck, codexDoctor } from './doctor.js';
export { AppServerError, JsonRpcLines, type JsonRpcLinesOptions, MethodNotFound } from './rpc.js';
