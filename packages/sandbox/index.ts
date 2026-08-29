// interface
export type {
  ExecResult,
  Sandbox,
  SandboxHook,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "./interface.ts";

// shared types
export type { Source, FileEntry, SandboxStatus } from "./types.ts";

// errors
export {
  SandboxError,
  SandboxCapabilityError,
  SandboxNotFoundError,
  SandboxProvisionError,
  SandboxProviderError,
} from "./errors.ts";

// provider registry + contracts
export {
  SandboxProviderRegistry,
  ensureDefaultProviders,
  getDefaultRegistry,
  resetDefaultRegistry,
} from "./provider.ts";
export type {
  CreateSandboxRequest,
  ConnectOptions,
  SandboxProvider,
  SandboxProviderType,
  SandboxState,
  VercelSandboxState,
} from "./provider.ts";

// factory
export {
  connectSandbox,
  createSandbox,
  type SandboxConnectConfig,
} from "./factory.ts";

// git helpers
export {
  hasUncommittedChanges,
  stageAll,
  getCurrentBranch,
  getHeadSha,
  getStagedDiff,
  getChangedFiles,
  detectBinaryFiles,
  readFileContents,
  getFileModes,
  syncToRemote,
  syncToRemotePreservingChanges,
  withTemporaryGitHubAuth,
  type FileChange,
  type FileChangeStatus,
  type FileWithContent,
} from "./git.ts";

// security policy (Phase 4.3)
export {
  checkCommand,
  checkFileSize,
  checkHost,
  confinePath,
  defaultCommandPolicy,
  defaultPathPolicy,
  defaultSecurityPolicy,
  ALLOW_ALL_NETWORK,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DENY_ALL_NETWORK,
  GITHUB_EGRESS_NETWORK,
  isPathDenied,
} from "./security.ts";
export type {
  CommandPolicyConfig,
  NetworkPolicyConfig,
  PathPolicyConfig,
  SandboxSecurityPolicy,
  SecurityCheckResult,
} from "./security.ts";

// runtime policy enforcement (Phase 4.4)
export {
  enforceSecurityPolicy,
  SandboxPolicyViolationError,
} from "./policy-enforcement.ts";

// vercel
export {
  connectVercelSandbox,
  VercelSandbox,
  type VercelSandboxConfig,
  type VercelSandboxConnectConfig,
  type VercelState,
} from "./vercel/index.ts";

// docker
export {
  DockerCliRuntime,
  DockerSandbox,
  DockerSandboxProvider,
  MemoryContainerRuntime,
  dockerSandboxProvider,
  type ContainerRuntime,
  type DockerSandboxConfig,
  type DockerSandboxState,
  type ExecOptions,
  type FileStat,
} from "./docker/index.ts";
