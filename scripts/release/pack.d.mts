/** Types of scripts/release/pack.mjs for the tests that run it (tests/integration/start.test.ts). */

export declare const REPO_ROOT: string;
export declare const RELEASE_DIR: string;

export declare function fridayVersion(): string;

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  archive: string;
  version: string;
  prefix: string;
  installed: string;
  checks: VerifyCheck[];
  url?: string;
  studio?: string;
}

export declare function verifyArchive(archive: string, opts?: { log?: (line: string) => void }): Promise<VerifyReport>;

export interface PackResult {
  archive: string;
  version: string;
  packageDir: string;
  dependencies: Record<string, string>;
  bundles: { name: string; out: string; bytes: number; modules: number; beside: string[] }[];
  verification: VerifyReport | null;
}

export declare function pack(opts?: {
  build?: boolean;
  verify?: boolean;
  log?: (line: string) => void;
}): Promise<PackResult>;
