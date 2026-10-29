import { unitProject } from '../../../vitest.shared.ts';

// Its doctor runs Friday's hook command through this machine's shell, once per case: on a busy
// machine a case passed 15 s (LESSONS T-110).
export default unitProject('@friday/adapter-cursor', { testTimeout: 60_000 });
