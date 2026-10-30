/**
 * @friday/code-graph
 * The file-level code graph of an execution root (ADR-0020): imports, consumers, tests and
 * shared contracts of TS/JS files, parsed with tree-sitter (WebAssembly), every edge labelled
 * exact, inferred or unsupported.
 */
export const PACKAGE_NAME = '@friday/code-graph';

export { FACTS_FORMAT, type FactsCache, memoryFactsCache, openFactsCache } from './cache.js';
export { extractImports, type ImportFact, type ImportKind } from './extract.js';
export {
  type BuildOptions,
  buildGraph,
  CodeGraph,
  type FileFacts,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
  isTestPath,
} from './graph.js';
export { LANGUAGES, type LanguageId, type LanguageSpec, languageOf } from './languages.js';
export {
  type BuildLayout,
  type Certainty,
  CONDITIONS,
  type ExportEntry,
  firstFile,
  matchPattern,
  type PathAliases,
  type Resolution,
  Resolver,
  readExports,
  readTsconfigPaths,
  readWorkspacePackages,
  sourceOfOutput,
  stripJsonComments,
  type WorkspacePackage,
} from './resolve.js';
