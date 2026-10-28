/**
 * @friday/protocol
 * Wire envelopes, harness protocol methods, event schemas, error codes and version negotiation.
 * No orchestration logic lives here (spec Part 10 §13).
 */
export const PACKAGE_NAME = '@friday/protocol';

export * from './api.js';
export * from './context.js';
export * from './enums.js';
export * from './envelope.js';
export * from './errors.js';
export * from './ids.js';
export * from './methods.js';
export * from './rpc.js';
export * from './version.js';
