/**
 * @friday/state
 * Command bus, projector, idempotency, queries and every M1 state operation.
 */
export const PACKAGE_NAME = '@friday/state';

export { CommandBus, type CommandContext, type CommandMeta, type CommandOutcome, stableStringify } from './bus.js';
export { ALL_MIGRATIONS, DOMAIN_TABLES, STATE_MIGRATIONS } from './migrations.js';
export { StateProjector } from './projector.js';
export { type HarnessRecord, Queries } from './queries.js';
export {
  type Caller,
  DEFAULT_STATE_CONFIG,
  FridayState,
  normalizePath,
  type StateConfig,
  type TokenInfo,
} from './service.js';
