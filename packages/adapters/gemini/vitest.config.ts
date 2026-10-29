import { unitProject } from '../../../vitest.shared.ts';

// The doctor's tests run the hook launcher and the host's shell: a longer ceiling under load (LESSONS T-63).
export default unitProject('@friday/adapter-gemini', { testTimeout: 60_000 });
