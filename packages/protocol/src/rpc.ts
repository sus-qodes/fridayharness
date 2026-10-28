import { z } from 'zod';
import { type ErrorCode, type ErrorName, FridayError } from './errors.js';

export const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().min(1).max(200), z.number().int()]),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export interface RpcErrorObject {
  /** Numeric part of the COS code, e.g. 2002. */
  code: number;
  message: string;
  data: { code: ErrorCode; name: ErrorName; retryable: boolean; details?: unknown };
}

export type RpcResponse<R = unknown> =
  | { jsonrpc: '2.0'; id: string | number | null; result: R }
  | { jsonrpc: '2.0'; id: string | number | null; error: RpcErrorObject };

export function rpcResult<R>(id: string | number | null, result: R): RpcResponse<R> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: string | number | null, err: FridayError): RpcResponse<never> {
  const data: RpcErrorObject['data'] = { code: err.code, name: err.errorName, retryable: err.retryable };
  if (err.details !== undefined) data.details = err.details;
  return { jsonrpc: '2.0', id, error: { code: Number(err.code.slice(4)), message: err.message, data } };
}

/** Converts an RPC error object back into a FridayError on the client side. */
export function fromRpcError(error: RpcErrorObject): FridayError {
  return FridayError.fromBody({
    error: { code: error.data?.code, message: error.message, details: error.data?.details },
  });
}
