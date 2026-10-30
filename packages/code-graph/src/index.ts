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
  type BuildProgress,
  buildGraph,
  CodeGraph,
  type FileFacts,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
  isTestPath,
  type SymbolEdge,
  type SymbolNode,
  type SymbolRef,
} from './graph.js';
export { LANGUAGES, type LanguageId, type LanguageSpec, languageOf, withTree } from './languages.js';
export {
  hashBytes,
  MERKLE_FORMAT,
  type MerkleStore,
  memoryMerkleStore,
  openMerkleStore,
  type TreeScan,
  treeHash,
} from './merkle.js';
export {
  checkRanges,
  collectDeclarations,
  countErrors,
  type Declaration,
  locateDeclaration,
  type PatchKind,
  type PatchPlan,
  type PatchResult,
  planPatch,
  type RangeStatus,
  type Want,
} from './patch.js';
export {
  type Affected,
  type BlastRadius,
  type BlastSeed,
  blastRadius,
  type Confidence,
  lookupSymbol,
  type Skeleton,
  type SymbolLookup,
  type SymbolMatch,
  skeletonOf,
  symbolKey,
} from './queries.js';
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
export {
  memorySearchIndex,
  openSearchIndex,
  SEARCH_FORMAT,
  type SearchHit,
  type SearchIndex,
  tokenize,
} from './search.js';
export {
  enclosingSymbol,
  extractFacts,
  type ImportBinding,
  MODULE_SYMBOL,
  type ParsedFacts,
  type ReferenceFact,
  type ReferenceKind,
  type SymbolFact,
  type SymbolKind,
} from './symbols.js';
