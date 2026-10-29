import { unitProject } from '../../vitest.shared.ts';

// Every test runs git several times; alone each takes 1 to 3 s, under the full parallel run it
// went past 15 s (LESSONS T-63).
export default unitProject('@friday/git', { testTimeout: 60_000 });
