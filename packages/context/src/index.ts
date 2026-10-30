/**
 * @friday/context
 * The context compiler (ADR-0022): permission-first, deterministic Part 14 packets from task
 * state, the execution root's git state, the code graph and scoped memory, ranked, budgeted,
 * cached by source version and explained.
 */
export const PACKAGE_NAME = '@friday/context';

export { ContextCache } from './cache.js';
export {
  boundRecord,
  type CompileInput,
  type ContextDeps,
  type ContextPolicy,
  type ContextProject,
  compileContext,
  executionRootOf,
  packetStaleness,
  RECORD_LIMIT_BYTES,
  repositoryShape,
  SHAPE_MAX_CHARS,
} from './compile.js';
export { createReadFilter, type ReadFilter, type ReadFilterInput, type ReadGrant } from './read-filter.js';
