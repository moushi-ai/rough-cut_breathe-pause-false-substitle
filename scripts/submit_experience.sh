#!/bin/bash
#
# 将“人工确认过”的团队经验规则作为唯一文件提交并推送到当前远程分支。
#
# 用法:
#   bash scripts/submit_experience.sh "来源视频或本次学习主题"
#   bash scripts/submit_experience.sh --dry-run "来源视频或本次学习主题"
#
# 安全约束：
#   - 仅允许提交 用户习惯/经验规则.md；不混入同事本地的其它修改。
#   - 先运行凭证/确认状态校验。
#   - 不自动 pull / rebase / force push；远程冲突时保留本地 commit，交给用户处理。

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "用法: $0 [--dry-run] \"来源视频或本次学习主题\""
  exit 1
fi

SOURCE="$1"
case "$SOURCE" in
  *$'\n'*|*$'\r'*)
    echo "❌ 提交说明不能包含换行"
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RULES_REL="用户习惯/经验规则.md"

cd "$ROOT_DIR"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "❌ 当前 skill 不是 Git 工作副本，无法向团队仓库提交经验"
  exit 1
}

node "$SCRIPT_DIR/validate_experience_rules.js" "$RULES_REL" --require-confirmed

CURRENT_BRANCH="$(git branch --show-current)"
if [ -z "$CURRENT_BRANCH" ]; then
  echo "❌ 当前处于 detached HEAD；请切换到团队协作分支后再提交"
  exit 1
fi

if ! git var GIT_AUTHOR_IDENT >/dev/null 2>&1; then
  echo "❌ 未配置 Git 提交身份；请先设置 git config user.name 和 git config user.email"
  exit 1
fi

# 已暂存的无关文件可能来自同事自己的工作，绝不替其带入经验提交。
STAGED_OTHER="$(git diff --cached --name-only -- | awk -v rules="$RULES_REL" '$0 != rules { print }')"
if [ -n "$STAGED_OTHER" ]; then
  echo "❌ 检测到已暂存的无关文件，拒绝混入经验提交："
  printf '%s\n' "$STAGED_OTHER"
  exit 1
fi

if git diff --quiet -- "$RULES_REL" && git diff --cached --quiet -- "$RULES_REL"; then
  echo "❌ $RULES_REL 没有可提交的变更"
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "✅ 预检通过；将只提交并推送：$RULES_REL"
  echo "   分支: $CURRENT_BRANCH"
  echo "   提交说明: learn: $SOURCE"
  exit 0
fi

git add -- "$RULES_REL"
git diff --cached --quiet -- "$RULES_REL" && {
  echo "❌ 暂存后没有发现经验规则变更"
  exit 1
}
git commit -m "learn: $SOURCE" -- "$RULES_REL"
COMMIT="$(git rev-parse --short HEAD)"

if git push origin "$CURRENT_BRANCH"; then
  echo "✅ 团队经验已推送"
  echo "   commit: $COMMIT"
  echo "   branch: $CURRENT_BRANCH"
else
  echo "⚠️ 本地经验 commit 已创建（$COMMIT），但推送失败。"
  echo "   未执行 pull / rebase / force push；请先处理远程冲突或权限后再运行 git push origin $CURRENT_BRANCH。"
  exit 1
fi
