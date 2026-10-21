/**
 * 引擎包的公开 API。
 *
 * 引擎是跨形态复用的唯一资产：桌面版（Tauri）、内网 Web 版、MCP Server
 * 都是它的调用方。因此对外只暴露这一层，内部的模块划分可以自由演进。
 */
export { LocalFolderStore, NotFoundError, OccupiedError, PathEscapeError, lockCandidates, sha256, existsFromErrorCode } from './workspace/index.ts';
export type { FileStat, WorkspaceAdapter } from './workspace/index.ts';

export { RootRegistry } from './workspace/roots.ts';
export type { WorkspaceRoot, ResolvedPath } from './workspace/roots.ts';

export { MemoryStore } from './workspace/memory-store.ts';
export { HttpProjectStore } from './workspace/http-store.ts';
export type { HttpProjectStoreOptions } from './workspace/http-store.ts';
export { FileHandleStore } from './workspace/file-handle-store.ts';
export type { FileHandleStoreOptions, FileSystemAccessLike } from './workspace/file-handle-store.ts';

/* ── ③a-1：项目清单（源数据原地 + .cartouche/ 旁挂目录） ── */

export {
  PROJECT_MANIFEST_VERSION,
  ManifestError,
  newManifest,
  parseManifest,
  serializeManifest,
} from './project/index.ts';
export type {
  ProjectLayer,
  ProjectLayerKind,
  ProjectManifest,
  ProjectOperation,
  ProjectSheet,
  ProjectView,
} from './project/index.ts';

export { ProjectStore, PROJECT_DIR_NAME } from './project/index.ts';
export type { ProjectOutput, ProjectHistoryEntry } from './project/index.ts';

export { resolveGdal, gdalEnv, candidateBinDirs } from './gdal/env.ts';
export type { GdalLocation } from './gdal/env.ts';
export { runTool, tools, classifyError } from './gdal/runner.ts';
export type { GdalTools, ToolResult, GdalErrorKind, ClassifiedError } from './gdal/runner.ts';
export { probeDataset, listDrivers } from './gdal/probe.ts';
export type { DatasetInfo, RasterInfo, VectorInfo, CrsInfo } from './gdal/probe.ts';
export { writeBack, backupPathFor, createBackup, replaceFileAtomically } from './gdal/writeback.ts';
export type { WriteBackRequest, WriteBackResult, WriteBackSidecar } from './gdal/writeback.ts';

export { runHealthCheck } from './health/checks.ts';
export type { HealthReport, HealthOptions, Finding, Severity } from './health/checks.ts';

export { TemplateRegistry, TemplateError, builtinTemplates } from './templates/registry.ts';
export type {
  OperationTemplate,
  OperationPlan,
  TemplateParamSpec,
  TemplateSummary,
  TemplateParamSummary,
  ParamType,
} from './templates/registry.ts';

export { CommandStack } from './undo/command-stack.ts';
export type { Command } from './undo/command-stack.ts';

export {
  CommunityLicenseService,
  COMMUNITY_CAPABILITIES,
  parseLicenseFile,
} from './license/service.ts';
export type { Capability, LicenseInfo, LicenseService, LicenseFileV1 } from './license/service.ts';

export { RasterEditor } from './raster/index.ts';
export type { RasterOpResult, RasterDeps } from './raster/index.ts';
export { readRasterPixels, writeRasterPixels } from './raster/index.ts';
export type { RasterPixels } from './raster/index.ts';

export {
  ByokKeyProvider,
  ManagedKeyProvider,
  KeyProviderRegistry,
  MiniMaxProvider,
  SessionKeyProvider,
  redactSecrets,
  MINIMAX_MODELS,
  MINIMAX_EFFORT_LEVELS,
  MINIMAX_DEFAULT_EFFORT,
  MINIMAX_CN_BASE_URL,
  MINIMAX_CN_ANTHROPIC_BASE_URL,
  MINIMAX_INTL_BASE_URL,
  MINIMAX_INTL_ANTHROPIC_BASE_URL,
} from './key-provider.ts';
export type {
  KeyProvider,
  LlmCredentials,
  LlmProviderId,
  CredentialReader,
} from './key-provider.ts';

/* ── S5：样式转换 / 兼容性报告 / 出图 ── */

export {
  cimToMapLibreLayers,
  describeRenderer,
  cimColorToCss,
  cimRgbToRgba,
  cimHsvToRgba,
  pickLayerType,
  toLayerId,
} from './style/index.ts';
export type {
  CimToStyleOptions,
  CimToStyleResult,
  MapLibreLayer,
  MapLibreLayerType,
  MapLibrePaint,
} from './style/index.ts';

export { renderCompatReport } from './report/index.ts';
export type { CompatOperation, CompatReport, CompatReportInput } from './report/index.ts';

export {
  renderRasterPng,
  readPngSize,
  RasterRenderError,
  buildPdfFromJpeg,
  inspectPdf,
  PdfBuildError,
  A4_LANDSCAPE_PT,
  A4_PORTRAIT_PT,
  vectorToGeoJson,
  VectorConvertError,
  datasetExtent,
  DatasetExtentError,
} from './export/index.ts';
export type {
  BBox4326,
  RasterRenderOptions,
  RasterRenderResult,
  PdfOptions,
  VectorToGeoJsonOptions,
  VectorToGeoJsonResult,
  DatasetExtentOptions,
  DatasetExtentResult,
} from './export/index.ts';
