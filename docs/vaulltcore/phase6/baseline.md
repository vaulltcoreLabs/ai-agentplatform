# Phase 6 Forensic Baseline

**Final Git SHA:** c25c620471ea962481e38d8aedf9cd6b0e112186
**Report Date:** 2026-08-29
**Branch:** main

---

## 1. Frontend Stack

| Technology | Version | Role |
|-----------|---------|------|
| **React** | 19.2.3 | UI framework |
| **React DOM** | 19.2.3 | DOM renderer |
| **React Router DOM** | ^7.18.2 | Client-side routing (BrowserRouter) |
| **Vite** | ^8.2.2 | Build tool + dev server |
| **@vitejs/plugin-react** | ^6.1.0 | React Fast Refresh |
| **TypeScript** | ^5 | Type system |
| **Tailwind CSS** | ^4 | Utility CSS framework |
| **@tailwindcss/postcss** | ^4 | PostCSS plugin |
| **tw-animate-css** | ^1.4.0 | Tailwind animation utilities |
| **shadcn/ui** (New York) | — | Component library (Radix-based) |
| **Radix UI** | various | Primitives (dialog, dropdown, popover, scroll-area, select, switch, tabs, tooltip, avatar, separator, label, slot) |
| **lucide-react** | ^0.562.0 | Icon library |
| **SWR** | ^2.3.8 | Data fetching/caching |
| **AI SDK** (`ai` + `@ai-sdk/react`) | catalog (ai ^6.0.165) | Chat streaming + UI message primitives |
| **sonner** | ^2.0.7 | Toast notifications |
| **cmdk** | ^1.1.1 | Command palette |
| **vaul** | ^1.1.2 | Drawer component |
| **date-fns** | ^4.1.0 | Date formatting |
| **clsx** + **tailwind-merge** | ^2.1.1 / ^3.4.0 | Class utilities (`cn()`) |
| **class-variance-authority** | ^0.7.1 | Variant-based styling |
| **streamdown** | ^2.5.0 + `@streamdown/code` | Markdown/streaming rendering |
| **react-day-picker** | ^9.14.0 | Date picker |
| **nanoid** | ^5.1.6 | ID generation |

### Important Architecture Note

This is **NOT** a Next.js app. It is a **Vite SPA** with React Router for client-side routing and API routes that are served by a **separate Hono backend** (`apps/api/`). The Vite dev server proxies `/api` requests to the Hono backend on `localhost:3001`. The `app/` directory convention mirrors Next.js file-based routing but is actually used with React Router `<Route>` definitions in `src/app.tsx`.

---

## 2. Server-Side Stack (Backend)

| Technology | Version | Role |
|-----------|---------|------|
| **Hono** | ^4.9.8 | HTTP framework (`apps/api`) |
| **@hono/node-server** | ^2.1.1 | Node.js adapter for Hono |
| **Better Auth** | ^1.6.5 | Authentication (Vercel + GitHub OAuth) |
| **Drizzle ORM** | ^0.45.1 | Database ORM |
| **@neondatabase/serverless** | ^1.1.0 | Neon PostgreSQL driver |
| **postgres** | ^3.4.8 | PostgreSQL driver (server-side) |
| **Workflow SDK** (`workflow`) | 5.0.0-beta.5 | Durable workflow execution |
| **AI SDK** (`@workflow/ai`) | 5.0.0-beta.4 | Agent workflow AI integration |
| **@vercel/oidc** | ^2.0.0 | Vercel OIDC token for sandbox auth |
| **Zod** | ^4.3.6 | Schema validation |
| **jose** | ^6.1.3 | JWT/JWE operations |
| **resend** | ^6.22.1 | Email (optional) |
| **botid** | ^1.5.11 | Bot protection |
| **ioredis** | ^5.9.2 | Redis client (optional skills cache) |
| **cloudflare** | ^7.1.0 | Cloudflare integration |

### Workspace Packages (Internal)

| Package | Path | Role |
|---------|------|------|
| `@vaulltcore/agent` | `packages/agent/` | Agent engine, model resolution, tools |
| `@vaulltcore/sandbox` | `packages/sandbox/` | Sandbox interface + Vercel provider |
| `@vaulltcore/intelligence` | `packages/intelligence/` | Planning, DAG, scheduling, verification |
| `@vaulltcore/workflow` | `packages/workflow/` | Durable runtime, SharedBackend, worker |
| `@vaulltcore/shared` | `packages/shared/` | Shared utilities |
| `@vaulltcore/adapters` | `packages/adapters/` | SQLite, PostgreSQL, in-memory backends |
| `@vaulltcore/storage` | `packages/storage/` | Object store, artifact lifecycle, R2 adapter |

---

## 3. Routing Inventory

### React Router (Client-Side)

```
/                                    → HomeRoute (redirect to /sessions if authenticated)
/sessions                            → SessionsLayoutRoute → SessionsIndexRoute
/sessions/:sessionId                  → SessionRedirectRoute (redirects to first chat)
/sessions/:sessionId/chats/:chatId    → ChatRoute (main chat interface)
/codespace/:sessionId                → CodespaceRoute (embedded code editor)
/get-started/*                       → GetStartedRoute
/deploy-your-own                     → DeployRoute
/settings                            → SettingsLayoutRoute
/settings/profile                    → SettingsProfileRoute
/settings/connections                → SettingsConnectionsRoute
/settings/models                     → SettingsModelsRoute
/settings/leaderboard                → SettingsLeaderboardRoute
/settings/admin                      → SettingsAdminRoute (admin-only)
/settings/preferences                → SettingsPreferencesRoute
/settings/usage                      → SettingsUsageRoute
/shared/:shareId                     → SharedChatRoute (public shared chats)
/:username                           → PublicProfileRoute
/:username/:repo                     → RepoPageRoute
```

### API Routes (Server-Side via Hono backend proxy)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/info` | Yes (cookie) | Current session info |
| POST | `/api/chat` | Yes | Start chat workflow (streaming) |
| POST | `/api/chat/:chatId/stop` | Yes | Stop active stream |
| GET | `/api/chat/:chatId/stream` | Yes | Reconnect to existing stream |
| GET | `/api/sessions` | Yes | List user sessions |
| POST | `/api/sessions` | Yes | Create new session |
| GET | `/api/sessions/:sessionId` | Yes | Get session details |
| PATCH | `/api/sessions/:sessionId` | Yes | Update session |
| DELETE | `/api/sessions/:sessionId` | Yes | Archive/delete session |
| POST | `/api/sessions/:sessionId/share` | Yes | Create share link |
| GET | `/api/sessions/:sessionId/chats` | Yes | List chats in session |
| POST | `/api/sessions/:sessionId/chats` | Yes | Create new chat |
| GET | `/api/sessions/:sessionId/chats/:chatId` | Yes | Get chat with messages |
| PATCH | `/api/sessions/:sessionId/chats/:chatId` | Yes | Update chat |
| POST | `/api/sessions/:sessionId/chats/:chatId/fork` | Yes | Fork chat |
| POST | `/api/sessions/:sessionId/chats/:chatId/read` | Yes | Mark chat as read |
| POST | `/api/sessions/:sessionId/chats/:chatId/share` | Yes | Share chat |
| GET/POST | `/api/sessions/:sessionId/chats/:chatId/messages` | Yes | List/create messages |
| PATCH | `/api/sessions/:sessionId/chats/:chatId/messages/:messageId` | Yes | Update message |
| GET | `/api/sessions/:sessionId/diff` | Yes | Get session diff |
| GET | `/api/sessions/:sessionId/diff/cached` | Yes | Get cached diff |
| POST | `/api/sessions/:sessionId/diff/patch` | Yes | Apply diff patch |
| GET | `/api/sessions/:sessionId/files` | Yes | List session files |
| GET | `/api/sessions/:sessionId/files/content` | Yes | Get file content |
| POST | `/api/sessions/:sessionId/code-editor` | Yes | Launch/check code editor |
| POST | `/api/sessions/:sessionId/dev-server` | Yes | Manage dev server |
| POST | `/api/sessions/:sessionId/generate-commit-message` | Yes | Generate commit message |
| GET | `/api/sessions/:sessionId/skills` | Yes | List session skills |
| POST | `/api/sessions/:sessionId/checks/fix` | Yes | Fix check issues |
| GET/POST | `/api/github/*` | Yes | GitHub integration (repos, branches, webhooks, orgs, installations) |
| GET | `/api/models` | Yes | List available models |
| POST | `/api/generate-pr` | Yes | Generate PR from changes |
| POST | `/api/generate-title` | Yes | Generate chat title |
| GET | `/api/sandbox/*` | Yes | Sandbox management (status, activity, reconnect, extend, snapshot) |
| POST | `/api/artifacts/reserve` | Yes | Reserve artifact upload |
| POST | `/api/artifacts/confirm` | Yes | Confirm artifact upload |
| DELETE | `/api/artifacts/:artifactId` | Yes | Delete artifact |
| GET | `/api/artifacts/download/:artifactId` | Yes | Download artifact |
| GET/PUT | `/api/settings/preferences` | Yes | User preferences |
| GET/PUT | `/api/settings/model-variants` | Yes | Model variant config |
| GET | `/api/usage` | Yes | Usage data |
| GET | `/api/usage/rank` | Yes | Usage ranking |
| GET | `/api/users/:username/usage` | Yes | Public user usage |
| POST | `/api/transcribe` | Yes | Voice transcription |
| GET | `/api/repos/:owner/:repo/create-session` | Yes | Quick-create from repo |
| GET | `/api/shared/:shareId` | No | Shared chat data |
| GET | `/api/shared/:shareId/markdown` | No | Shared chat as markdown |
| GET | `/api/shared/:shareId/status` | No | Shared chat status |
| POST | `/api/repos/:owner/:repo/create-session` | Yes | Create session from repo URL |

---

## 4. Database Schema (Drizzle → Neon PostgreSQL)

### Tables

| Table | Primary Key | Key Columns | Description |
|-------|------------|-------------|-------------|
| `users` | `id` (text) | username, email, avatarUrl, isAdmin | User accounts |
| `accounts` | `id` (text) | accountId, providerId, userId, accessToken, refreshToken | OAuth accounts |
| `auth_sessions` | `id` (text) | token, userId, expiresAt | Better Auth sessions |
| `verification` | `id` (text) | identifier, value, expiresAt | Auth verification tokens |
| `github_installations` | `id` (text) | userId, installationId, accountLogin, accountType | GitHub App installations |
| `vercel_project_links` | (userId, repoOwner, repoName) | projectId, projectName, teamId | Vercel project links |
| `sessions` | `id` (text) | userId, title, status, repoOwner, repoName, branch, sandboxState, lifecycleState | Agent sessions |
| `chats` | `id` (text) | sessionId, title, modelId, activeStreamId | Chat conversations |
| `shares` | `id` (text) | chatId | Public share links |
| `chat_messages` | `id` (text) | chatId, role, parts (JSONB) | Chat messages |
| `chat_reads` | (userId, chatId) | lastReadAt | Read receipts |
| `workflow_runs` | `id` (text) | chatId, sessionId, userId, modelId, status, startedAt, finishedAt | Workflow execution records |
| `workflow_run_steps` | `id` (text) | workflowRunId, stepNumber, startedAt, finishedAt, durationMs | Step timing records |
| `user_preferences` | `id` (text) | userId (unique), defaultModelId, autoCommitPush, autoCreatePr, modelVariants | User settings |
| `usage_events` | `id` (text) | userId, provider, modelId, inputTokens, outputTokens, toolCallCount | Usage tracking (append-only) |
| `artifacts` | (tenantId, runId, artifactId) | objectKey, lifecycle, contentType, byteSize, sha256 | Artifact metadata (R2 bodies separate) |

### Key Relationships

```
users 1:N accounts
users 1:N sessions
users 1:N auth_sessions
users 1:1 user_preferences
users 1:N usage_events
sessions 1:N chats
sessions N:1 github_installations (via userId)
chats 1:N chat_messages
chats 1:1 shares
chats 1:N workflow_runs
workflow_runs 1:N workflow_run_steps
(tenantId, runId) N:N artifacts
```

### Session Status Enum

```
"running" | "completed" | "failed" | "archived"
```

### Session Lifecycle States

```
"provisioning" | "active" | "hibernating" | "hibernated" | "restoring" | "archived" | "failed"
```

### Artifact Lifecycle

```
RESERVED → UPLOADING → READY → DELETING → DELETED
                                         ↘ FAILED
```

---

## 5. Authentication Flow

1. **Better Auth** handles auth via `/api/auth/[...all]` catchall
2. **Vercel OAuth** — primary sign-in provider
3. **GitHub OAuth** — secondary provider (repo access)
4. **Session management** — Better Auth's built-in session cookies
5. **Client-side session** — `useSession()` hook fetches `/api/auth/info` via SWR
6. **Server-side session** — `getServerSession()` reads cookies in server components

### Auth Guard Pattern

```tsx
// Client-side
<AuthGuard>
  <ProtectedContent />
</AuthGuard>

// Server-side (React Router)
<RequireAuth>
  <ProtectedContent />
</RequireAuth>

// API routes
const auth = await requireAuthenticatedUser(req.headers);
if (!auth.ok) return auth.response;
```

### Session Info Shape

```typescript
interface SessionUserInfo {
  user: {
    id: string;
    username: string;
    email: string | undefined;
    avatar: string;
    name?: string;
  };
  authProvider?: "vercel" | "github";
  isAdmin?: boolean;
  hasGitHub?: boolean;
  hasGitHubAccount?: boolean;
  hasGitHubInstallations?: boolean;
}
```

---

## 6. Existing Component Inventory

### Auth Components (`components/auth/`)

| Component | Purpose |
|-----------|---------|
| `auth-guard.tsx` | Client-side auth wrapper |
| `sign-in-button.tsx` | Sign-in CTA |
| `signed-out-hero.tsx` | Landing page for signed-out users |
| `hero-app-mockup.tsx` | Animated app preview for landing |
| `hero-icons.tsx` | Hero section icons |

### Landing Page (`components/landing/`)

| Component | Purpose |
|-----------|---------|
| `nav.tsx` | Landing page navigation |
| `logo.tsx` | Brand logo |
| `footer.tsx` | Landing page footer |
| `features.tsx` | Feature showcase |
| `feature-agent.tsx` | Agent feature card |
| `feature-sandbox.tsx` | Sandbox feature card |
| `feature-workflow.tsx` | Workflow feature card |
| `bento.tsx` | Bento grid layout |
| `stage.tsx` | Staged feature reveal |
| `terminal.tsx` | Terminal mockup component |
| `window.tsx` | macOS window chrome |
| `app-mockup.tsx` | App preview mockup |
| `github-link.tsx` | GitHub star button |
| `theme-toggle.tsx` | Light/dark theme toggle |

### Chat/Session Components

| Component | Purpose |
|-----------|---------|
| `inbox-sidebar.tsx` | Session sidebar with chat list |
| `session-list.tsx` | Session list with date grouping |
| `session-drawer.tsx` | Mobile session drawer |
| `session-starter.tsx` | New session creation UI |
| `session-starter-vercel-sync-section.tsx` | Vercel project sync during session creation |
| `new-session-dialog.tsx` | New session dialog |
| `chat-switcher-dropdown.tsx` | Switch between chats in session |
| `model-selector-compact.tsx` | Model selection dropdown |
| `model-combobox.tsx` | Model search/selection |
| `repo-selector.tsx` | Repository selection |
| `repo-selector-compact.tsx` | Compact repo selection |
| `repo-selection-screen.tsx` | Full repo selection screen |
| `branch-selector.tsx` | Branch selection |
| `branch-selector-compact.tsx` | Compact branch selection |
| `branch-picker-dialog.tsx` | Branch picker dialog |
| `sandbox-selector-compact.tsx` | Sandbox type selector |
| `inline-question-input.tsx` | Inline question input |

### Tool Call Rendering (`components/tool-call/`)

| Component | Purpose |
|-----------|---------|
| `tool-call.tsx` | Main tool call dispatcher |
| `tool-layout.tsx` | Tool call layout wrapper |
| `approval-buttons.tsx` | Tool approval/deny buttons |
| `file-name-pill.tsx` | File name display |
| `open-file-context.tsx` | File open context |
| `renderers/bash-renderer.tsx` | Shell command rendering |
| `renderers/read-renderer.tsx` | File read rendering |
| `renderers/write-renderer.tsx` | File write rendering |
| `renderers/edit-renderer.tsx` | File edit rendering |
| `renderers/glob-renderer.tsx` | Glob search rendering |
| `renderers/grep-renderer.tsx` | Grep search rendering |
| `renderers/task-renderer.tsx` | Task rendering |
| `renderers/todo-renderer.tsx` | Todo rendering |
| `renderers/ask-user-question-renderer.tsx` | Question rendering |
| `renderers/fetch-renderer.tsx` | Web fetch rendering |
| `renderers/skill-renderer.tsx` | Skill rendering |

### Message/Chat Display

| Component | Purpose |
|-----------|---------|
| `assistant-message-groups.tsx` | Message grouping |
| `assistant-file-link.tsx` | File link in messages |
| `thinking-block.tsx` | AI thinking/reasoning display |
| `message-model-pill.tsx` | Model identifier pill |
| `tool-calls-summary-bar.tsx` | Tool calls summary |
| `pinned-todo-panel.tsx` | Pinned todo items |
| `snippet-chip.tsx` | Code snippet chip |
| `image-attachments-preview.tsx` | Image attachment preview |
| `text-attachments-preview.tsx` | Text attachment preview |

### Git/PR Components

| Component | Purpose |
|-----------|---------|
| `create-pr-dialog.tsx` | Create PR dialog |
| `close-pr-dialog.tsx` | Close PR dialog |
| `merge-pr-dialog.tsx` | Merge PR dialog |
| `merge-pr-dialog-actions.tsx` | Merge PR actions |
| `commit-dialog.tsx` | Commit dialog |
| `merge-check-runs.tsx` | CI check status |
| `contribution-chart.tsx` | Contribution visualization |
| `diffs-provider.tsx` | Diff context provider |
| `task-group-view.tsx` | Task group visualization |

### GitHub Integration

| Component | Purpose |
|-----------|---------|
| `github-reconnect-dialog.tsx` | GitHub reconnection |
| `github-reconnect-gate.tsx` | GitHub reconnection gate |

### UI Primitives (`components/ui/`)

| Component | Source |
|-----------|--------|
| `avatar.tsx` | Radix Avatar |
| `button.tsx` | Custom with CVA |
| `button-group.tsx` | Button group |
| `calendar.tsx` | react-day-picker |
| `card.tsx` | Card |
| `command.tsx` | cmdk |
| `date-range-picker.tsx` | Date range picker |
| `dialog.tsx` | Radix Dialog |
| `drawer.tsx` | vaul |
| `dropdown-menu.tsx` | Radix Dropdown Menu |
| `empty.tsx` | Empty state (Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyAction) |
| `field.tsx` | Form field |
| `image.tsx` | Image with fallback |
| `input.tsx` | Input |
| `input-group.tsx` | Input group |
| `label.tsx` | Radix Label |
| `popover.tsx` | Radix Popover |
| `scroll-area.tsx` | Radix Scroll Area |
| `select.tsx` | Radix Select |
| `separator.tsx` | Radix Separator |
| `sheet.tsx` | Sheet (side panel) |
| `sidebar.tsx` | Sidebar |
| `skeleton.tsx` | Loading skeleton |
| `switch.tsx` | Radix Switch |
| `table.tsx` | Table |
| `tabs.tsx` | Radix Tabs |
| `textarea.tsx` | Textarea |
| `tooltip.tsx` | Radix Tooltip |

### Settings Components

| Component | Purpose |
|-----------|---------|
| `user-avatar-dropdown.tsx` | User menu (settings, sign out) |

---

## 7. Existing Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useSession` | `hooks/use-session.ts` | Auth session via SWR (`/api/auth/info`) |
| `useSessions` | `hooks/use-sessions.ts` | Session list + CRUD via SWR (`/api/sessions`) |
| `useSessionChats` | `hooks/use-session-chats.ts` | Chat list for a session |
| `useSessionDiff` | `hooks/use-session-diff.ts` | File diff for a session |
| `useSessionFiles` | `hooks/use-session-files.ts` | File listing for a session |
| `useSessionGitStatus` | `hooks/use-session-git-status.ts` | Git status for a session |
| `useSessionSkills` | `hooks/use-session-skills.ts` | Skills for a session |
| `useGitHubConnectionStatus` | `hooks/use-github-connection-status.ts` | GitHub connection state |
| `useInstallationRepos` | `hooks/use-installation-repos.ts` | GitHub installation repos |
| `useModelOptions` | `hooks/use-model-options.ts` | Available model options |
| `useMobile` | `hooks/use-mobile.ts` | Mobile breakpoint detection |
| `useScrollToBottom` | `hooks/use-scroll-to-bottom.ts` | Auto-scroll behavior |
| `useSlashCommands` | `hooks/use-slash-commands.ts` | Slash command detection |
| `useFileSuggestions` | `hooks/use-file-suggestions.ts` | File path autocomplete |
| `useImageAttachments` | `hooks/use-image-attachments.ts` | Image attachment handling |
| `useTextAttachments` | `hooks/use-text-attachments.ts` | Text attachment handling |
| `useAudioRecording` | `hooks/use-audio-recording.ts` | Voice input recording |
| `useBackgroundChatNotifications` | `hooks/use-background-chat-notifications.tsx` | Background chat alerts |
| `useLeaderboardRank` | `hooks/use-leaderboard-rank.ts` | Usage leaderboard ranking |
| `useUserPreferences` | `hooks/use-user-preferences.ts` | User preference management |
| `useVercelRepoProjects` | `hooks/use-vercel-repo-projects.ts` | Vercel project linking |

---

## 8. Data Fetching Pattern

- **SWR** for all client-side data fetching
- **Server-side** data loading in React Router loaders (equivalent to Next.js server components)
- **Streaming** via Vercel AI SDK `createUIMessageStreamResponse` for chat
- **Workflow SDK** for durable agent execution

### SWR Configuration

```typescript
// Global SWR config in providers.tsx
<SWRConfig
  value={{
    fetcher,
    onError: (error) => {
      // Handle 401 → sign out
      if (error instanceof FetchError && error.status === 401) {
        authClient.signOut();
      }
    },
  }}
>
```

### Chat Streaming Flow

```
1. Client POST /api/chat → starts workflow via `start(runAgentWorkflow, [...])`
2. Server returns ReadableStream<WebAgentUIMessageChunk>
3. Client renders via useChat / streaming UI
4. Workflow persists messages, tool results, git ops
5. Active stream tracked by `chat.activeStreamId` (CAS-fenced)
6. Reconnection via GET /api/chat/:chatId/stream
```

---

## 9. Existing UX Flows

### Authenticated User Journey

```
1. Landing Page (/) → "Sign In" CTA
2. Vercel/GitHub OAuth → /sessions
3. Sessions Layout (sidebar + content)
   ├── Session list (grouped by date)
   ├── Session starter (repo/branch selection)
   └── Session drawer (mobile)
4. Session Detail (/sessions/:sessionId)
   → Redirects to first chat
5. Chat (/sessions/:sessionId/chats/:chatId)
   ├── Message input (text, image, voice attachments)
   ├── Model selector
   ├── Chat messages with tool calls
   ├── Diff viewer
   ├── File browser
   └── Settings (per-session)
6. Codespace (/codespace/:sessionId)
   → Embedded code editor (browser IDE)
7. Settings (/settings)
   ├── Profile
   ├── Preferences (default model, auto-commit, etc.)
   ├── Connections (GitHub, Vercel)
   ├── Models (model configuration)
   ├── Leaderboard (usage rankings)
   ├── Usage (usage analytics)
   └── Admin (admin-only)
```

### Shared Chat Flow

```
1. Share button in chat → creates share link
2. Public URL (/shared/:shareId)
3. Read-only chat view
4. Markdown export available
```

---

## 10. Design System

### Theme System

- Light/dark mode via CSS variables (oklch color space)
- Theme stored in localStorage (`open-agents-theme`)
- System preference detection
- `ThemeContext` for React components

### Color Tokens (from globals.css)

**Light mode:**
- Background: `oklch(1 0 0)` (white)
- Foreground: `oklch(0.141 0.005 285.823)` (near-black)
- Card: `oklch(1 0 0)` (white)
- Primary: `oklch(0.21 0.006 285.885)` (dark)
- Secondary: `oklch(0.967 0.001 286.375)` (light gray)

**Dark mode:**
- Background: `oklch(0.141 0.005 285.823)` (dark)
- Foreground: `oklch(0.985 0 0)` (near-white)
- Card: `oklch(0.21 0.006 285.885)` (dark card)
- Primary: `oklch(0.92 0.004 286.32)` (light)
- Secondary: `oklch(0.274 0.006 286.033)` (dark secondary)

### Spacing & Radius

- Base radius: `0.625rem`
- Responsive breakpoints: Tailwind defaults + custom `sidebar: 900px`

### Landing Page Theme

Separate dark terminal aesthetic for marketing:
- `bg-primary: #0a0a0b`
- `bg-card: #111113`
- Emerald/blue/violet accents
- Glassmorphism, ambient glow, dot grid, scanline effects

---

## 11. Existing Tests

### Web App Tests (apps/web)

| Test File | Category |
|-----------|----------|
| `api/auth/info/route.test.ts` | Auth API |
| `api/chat/route.test.ts` | Chat API |
| `api/chat/[chatId]/stop/route.test.ts` | Chat stop |
| `api/chat/[chatId]/stream/route.test.ts` | Chat stream |
| `api/chat/_lib/model-selection.test.ts` | Model selection |
| `api/chat/_lib/persist-tool-results.test.ts` | Tool result persistence |
| `api/generate-pr/_lib/generate-pr-helpers.test.ts` | PR generation |
| `api/generate-title/route.test.ts` | Title generation |
| `api/models/route.test.ts` | Models API |
| `api/sandbox/route.test.ts` | Sandbox API |
| `api/sandbox/reconnect/route.test.ts` | Sandbox reconnect |
| `api/sandbox/snapshot/route.test.ts` | Sandbox snapshot |
| `api/sandbox/status/route.test.ts` | Sandbox status |
| `api/sessions/route.test.ts` | Sessions API |
| `api/sessions/[sessionId]/**/*.test.ts` | Session sub-routes |
| `api/settings/**/*.test.ts` | Settings API |
| `api/shared/**/*.test.ts` | Shared chat API |
| `api/vercel/**/*.test.ts` | Vercel integration |
| `sessions/[sessionId]/chats/[chatId]/*.test.ts` | Chat page tests |
| `workflows/*.test.ts` | Workflow logic tests |
| `components/**/*.test.ts(x)` | Component tests |
| `hooks/*.test.ts` | Hook tests |
| `lib/**/*.test.ts` | Library tests |

**Total web app tests:** ~80+ test files

### Package Tests

| Package | Test Files | Key Areas |
|---------|-----------|-----------|
| `packages/agent` | engine tests, model tests, tool tests | 46/48 pass (2 pre-existing skip) |
| `packages/sandbox` | contract, security, Vercel, Docker | 92/92 pass |
| `packages/intelligence` | planner, scheduler, verification, budget | 108/108 pass |
| `packages/workflow` | runtime, distributed, stores, leases, checkpoints | 239/239 pass |
| `packages/adapters` | conformance, PG, SQLite, phase48, phase5 | 46/46 pass |
| `packages/storage` | artifact, object-store, R2 gate | 24/24 pass |
| `packages/shared` | paste-blocks, tool-state | pass |

---

## 12. Protected Boundaries

The following must NOT be modified in Phase 6 without explicit justification:

### Provider-Neutral Core (NEVER modify)

- `packages/agent/engine/` — agent kernel
- `packages/intelligence/` — planning, scheduling, verification
- `packages/sandbox/contract.ts` — sandbox interface
- `packages/workflow/contracts.ts` — SharedBackend contract
- `packages/workflow/distributed-runtime.ts` — distributed runtime
- `packages/workflow/worker.ts` — durable worker
- `packages/workflow/leases.ts` — lease semantics
- `packages/workflow/checkpoints.ts` — checkpoint semantics
- `packages/workflow/retry.ts` — retry semantics
- `packages/workflow/status.ts` — status model

### Adapter Boundary (DO NOT add provider imports elsewhere)

- `packages/adapters/pg-backend.ts` — PostgreSQL adapter
- `packages/adapters/durable-sqlite.ts` — SQLite adapter
- `packages/storage/r2/r2-object-store.ts` — R2 adapter

### Infrastructure (DO NOT replace)

- Neon PostgreSQL — transactional datastore
- Cloudflare R2 — object storage
- Vercel Sandbox — execution environment
- Better Auth — authentication
- Workflow SDK — durable execution

### Existing Schema (DO NOT break)

- `apps/web/lib/db/schema.ts` — all existing tables
- Existing migrations in `apps/web/lib/db/migrations/`
- All existing API route response shapes

---

## 13. Existing Deficiencies

### Missing UI Surfaces

1. **No dedicated "Projects/Repositories" page** — repos are accessed through session creation only
2. **No dedicated "Artifacts" browsing UI** — artifact APIs exist but no list/download UI
3. **No dedicated "Activity/Events" page** — workflow run history is not surfaced
4. **No "Run" detail view** — workflow run status/timing is backend-only
5. **No "Agent" activity panel** — tool calls are inline in chat, no separate activity feed
6. **No dashboard with overview stats** — landing page is either signed-out hero or session list

### Missing States

1. **No explicit "recovering" state** in UI — backend supports reconciliation but UI doesn't show it
2. **No "retrying" state** displayed — backend supports retry but UI doesn't surface it
3. **No connection interruption handling** — streaming errors not gracefully degraded

### Missing Features

1. **No session-level settings page** (only global preferences)
2. **No per-chat model override UI** (model is set at session creation)
3. **No artifact upload/download UI** (APIs exist, no frontend)
4. **No workflow run history/timing visualization**
5. **No cost/token usage visualization per session**
6. **No multi-session comparison**
7. **No keyboard shortcuts** beyond basic browser navigation

---

## 14. File Organization Conventions

```
apps/web/
├── app/                    # Page-level components (route targets)
│   ├── api/               # API route handlers (proxy targets)
│   ├── codespace/         # Codespace page
│   ├── sessions/          # Sessions page components
│   ├── settings/          # Settings pages
│   ├── shared/            # Shared chat pages
│   ├── workflows/         # Workflow logic (server-side)
│   ├── [username]/        # Public profile pages
│   ├── types.ts           # Shared TypeScript types
│   └── providers.tsx      # Root providers
├── src/
│   ├── main.tsx           # Vite entrypoint
│   ├── app.tsx            # React Router definitions
│   ├── routes/            # Route wrapper components
│   └── auth-guard.tsx     # RequireAuth wrapper
├── components/
│   ├── auth/              # Auth-related components
│   ├── landing/           # Landing page components
│   ├── tool-call/         # Tool call rendering
│   ├── ui/                # shadcn/ui primitives
│   └── *.tsx              # Feature components
├── hooks/                 # Custom React hooks
├── lib/
│   ├── auth/              # Auth configuration
│   ├── db/                # Database schema, queries, migrations
│   ├── chat/              # Chat utilities
│   ├── sandbox/           # Sandbox configuration
│   ├── skills/            # Skills system
│   ├── storage/           # Artifact service wiring
│   ├── vercel/            # Vercel integration
│   └── *.ts               # Utility modules
├── docs/                  # Documentation
└── index.html             # Vite HTML entrypoint
```

### Naming Conventions

- **Files:** kebab-case
- **Components:** PascalCase
- **Functions:** camelCase
- **Types:** PascalCase
- **CSS:** Tailwind utilities + CSS variables

---

## 15. Environment Variables

### Required

```
POSTGRES_URL=              # Neon PostgreSQL connection
BETTER_AUTH_SECRET=        # Session signing key
```

### Required for Auth

```
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=    # Vercel OAuth (client)
VERCEL_APP_CLIENT_SECRET=            # Vercel OAuth (server)
```

### Required for GitHub

```
NEXT_PUBLIC_GITHUB_CLIENT_ID=        # GitHub App Client ID
GITHUB_CLIENT_SECRET=                # GitHub App Client Secret
GITHUB_APP_ID=                       # GitHub App ID
GITHUB_APP_PRIVATE_KEY=              # GitHub App private key (PEM or base64)
NEXT_PUBLIC_GITHUB_APP_SLUG=         # GitHub App slug
GITHUB_WEBHOOK_SECRET=               # Webhook secret
```

### Optional

```
ELEVENLABS_API_KEY=                  # Voice transcription
REDIS_URL=                           # Skills metadata cache
KV_URL=                              # Alternative to Redis
VAULLTCORE_RESOURCE_PROFILE=         # "hobby" for constrained deployments
VERCEL_PROJECT_PRODUCTION_URL=       # Canonical production URL
NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL=
VERCEL_SANDBOX_BASE_SNAPSHOT_ID=     # Custom sandbox base image
```

---

## 16. Summary Assessment

### What Exists

The application is a **functionally complete chat-driven coding agent** with:

- Full auth (Vercel + GitHub OAuth via Better Auth)
- Session management (CRUD, sidebar, drawers)
- Chat with streaming (Vercel AI SDK + Workflow SDK)
- Tool call rendering (12 tool types)
- Diff viewer and file browser
- GitHub integration (repos, branches, PRs, webhooks)
- Vercel sandbox management (provisioning, hibernation, snapshots)
- Settings (profile, preferences, models, connections, usage, leaderboard)
- Shared chat links
- Codespace (embedded code editor)
- Artifact upload/download APIs (no frontend)
- Dark/light theme
- Responsive layout (sidebar + content)
- Comprehensive test suite

### What Phase 6 Needs to Build

1. **Dashboard** — overview of sessions, runs, activity
2. **Projects/Repositories page** — dedicated repo management
3. **Artifacts UI** — list, download, manage artifacts
4. **Run/Workflow detail view** — timing, steps, status visualization
5. **Activity/Events feed** — structured event timeline
6. **Improved loading/empty/error states** — across all surfaces
7. **Recovery/retry UX** — surface backend durability features
8. **Accessibility audit** — keyboard nav, focus, ARIA
9. **Security audit** — secret exposure, XSS, presigned URL handling
10. **Performance measurement** — budgets and baselines

### What Phase 6 Must NOT Do

- Modify provider-neutral packages
- Replace backend infrastructure
- Invent APIs that don't exist
- Create mock production data in UI paths
- Weaken auth or tenant boundaries
- Introduce unnecessary dependencies
