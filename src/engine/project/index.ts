/**
 * 项目模块的出口。
 *
 * 只做 re-export：具体实现留在 `manifest.ts`（清单格式）与 `store.ts`（读写与留痕），
 * 引擎总出口 `src/engine/index.ts` 从这里取。
 */
export {
  PROJECT_MANIFEST_VERSION,
  ManifestError,
  newManifest,
  parseManifest,
  serializeManifest,
} from './manifest.ts';
export type {
  ProjectLayer,
  ProjectLayerKind,
  ProjectManifest,
  ProjectOperation,
  ProjectSheet,
  ProjectView,
} from './manifest.ts';
export { ProjectStore, PROJECT_DIR_NAME } from './store.ts';
export type { ProjectOutput, ProjectHistoryEntry } from './store.ts';
