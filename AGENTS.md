# AGENTS.md — 银河心事铺协作规则（所有 AI 必读）

> 本文件是仓库的最高协作约定。任何 AI（WorkBuddy、Cursor、Claude Code 等）在本仓库开始工作前，**必须先完整读完本文件**，再动手。

## 0. 一句话原则

**GitHub 仓库的 `main` 分支是唯一权威源。本地 `index.html` 只是派生副本；任何改动都必须先落到 GitHub，再同步出去。**

不在本地直接改完就发布，不允许两个 AI 同时改同一个文件。

---

## 1. 开工前（强制，按顺序）

1. **读本文件** `AGENTS.md`，以及 `README.md`。
2. **拉取最新**：`git fetch origin && git checkout main && git pull --ff-only origin main`
3. **认领任务**：在 `.claims/` 下建立 `你的任务名.json`，写明 `ai`、`task`、`file`、`started_at`。
   - 如果目标文件已有他人 claim，**停止**，改做别的任务或等待。
   - 任务结束删除自己的 claim 文件。
4. **开分支**：`git checkout -b ai/<任务名>-<YYYYMMDD>`
   - 分支名以 `ai/` 开头，禁止在 `main` 上直接提交。

## 2. 编辑中

- 一个分支只做一件事，改动尽量小、可回滚。
- 单文件 `index.html` 很容易冲突：**同一时间只允许一个 AI 编辑正文**。需要并行时拆成不同文件（如 `src/*.js`、`src/*.css`），最后由负责人合并进 `index.html`。
- 每次提交写清楚改了什么：`git commit -m "feat: 增加XX场景" / "fix: 修复XX"`。
- 不提交密钥：活页 `SPACE_TOKEN`、任何 API key 一律不进仓库，用环境变量传入。

## 3. 收尾（强制）

1. `git push origin ai/<任务名>-<YYYYMMDD>`
2. 在 GitHub 开 Pull Request，目标分支 `main`，说明改了什么、验证方式。
3. **不要自己 merge 别人的 PR**；冲突时以 `main` 为准，在自己的分支上 rebase 解决，禁止 `git push --force`。
4. PR 合并后：
   - `git checkout main && git pull`
   - 把 `index.html` 同步到发布目录：`meditation-room-h5-livepage/index.html`
   - 按 `PUBLISH.md` 发布到活页。

## 4. 发布规则

- 只有 **main 分支** 的内容允许发布到活页。
- 发布目录只放入口 `index.html`，不要放备份、脚本、manifest 以外的文件（历史上误传过 `index.backup.html`）。
- 标题/分享卡同步：发布后确认活页页面 `name`、`share.title`、`share.desc` 与 `index.html` 的 `<title>` 一致。

## 5. 禁止事项

- ❌ 直接在 `main` 上 `git push`
- ❌ 不拉取最新就开改
- ❌ 覆盖别人未合并的本地改动
- ❌ 把 token / 密钥写进文件
- ❌ 用 `git push --force` 覆盖 main
- ❌ 编造热线电话、语录出处等事实性内容

## 6. 多 AI 同时工作的推荐分工

| 角色 | 只改这些 | 不改这些 |
| --- | --- | --- |
| AI-A 内容 | `src/content.js`（引导词、小史、七步） | `index.html` |
| AI-B 交互 | `src/app.js`（向导、解锁、音频） | `index.html` |
| AI-C 样式 | `src/style.css` | `index.html` |
| 集成人 | `index.html`（合并 src）、发布 | — |

> 当前项目仍是单文件 `index.html`，所以在拆出 `src/` 之前，请严格用 claim 文件串行编辑。
