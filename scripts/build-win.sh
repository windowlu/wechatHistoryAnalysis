#!/bin/bash
#
# Windows 便携包构建脚本
# 在 macOS/Linux 上运行，生成 Windows 可用的 zip 包
#
# 用法:
#   ./scripts/build-win.sh              # 默认生成便携包（推荐）
#   ./scripts/build-win.sh --exe        # 用 pkg 生成单 exe（体积小，但有兼容限制）
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$PROJECT_DIR/release"
BUILD_DIR="$RELEASE_DIR/wechat-analysis-win"

NODE_VERSION="18.20.4"
PKG_TARGET="node18-win-x64"
BETTER_SQLITE3_VERSION="11.0.0"

echo "========================================"
echo "  微信聊天记录分析 - Windows 打包脚本"
echo "========================================"

# 解析参数
MODE="portable"
if [[ "${1:-}" == "--exe" ]]; then
  MODE="exe"
  echo "模式: 单 exe (pkg)"
else
  echo "模式: 便携包 (推荐)"
fi
echo ""

# 检查必需命令
for cmd in curl unzip node npm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "错误: 未找到命令 '$cmd'，请先安装"
    exit 1
  fi
done

# 清理旧构建
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

cd "$PROJECT_DIR"

# ═══════════════════════════════════════════
# 步骤 1: 安装依赖并编译
# ═══════════════════════════════════════════
echo "[1/6] 安装依赖并编译 TypeScript..."
npm install
npm run build

# ═══════════════════════════════════════════
# 步骤 2: 准备生产环境 node_modules
# ═══════════════════════════════════════════
echo "[2/6] 准备生产环境依赖..."
TEMP_DIR=$(mktemp -d)
cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$TEMP_DIR/"
(
  cd "$TEMP_DIR"
  npm ci --production --silent
)

# ═══════════════════════════════════════════
# 模式 A: 便携包 (Portable)
# 包含完整 Windows Node.js + 项目代码，最可靠
# ═══════════════════════════════════════════
if [[ "$MODE" == "portable" ]]; then
  echo "[3/6] 下载 Windows 版 Node.js v${NODE_VERSION}..."
  NODE_ZIP="node-v${NODE_VERSION}-win-x64.zip"
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}"

  if [[ ! -f "/tmp/${NODE_ZIP}" ]]; then
    curl -L --progress-bar -o "/tmp/${NODE_ZIP}" "$NODE_URL"
  fi

  unzip -q "/tmp/${NODE_ZIP}" -d "$BUILD_DIR"
  mv "$BUILD_DIR/node-v${NODE_VERSION}-win-x64" "$BUILD_DIR/node"

  echo "[4/6] 复制项目文件..."
  cp -R "$PROJECT_DIR/dist" "$BUILD_DIR/"
  cp -R "$TEMP_DIR/node_modules" "$BUILD_DIR/"
  cp "$PROJECT_DIR/config.example.json" "$BUILD_DIR/"
  [[ -f "$PROJECT_DIR/README.md" ]] && cp "$PROJECT_DIR/README.md" "$BUILD_DIR/"

  echo "[5/6] 生成启动脚本..."
  cat > "$BUILD_DIR/运行分析.bat" << 'BATEOF'
@echo off
chcp 65001 >nul
title 微信聊天记录分析工具
cd /d "%~dp0"

:: 检查管理员权限（PyWxDump 需要）
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限运行，正在申请...
    powershell -Command "Start-Process '%~f0' -Verb runAs"
    exit /b
)

:: 检查配置文件
echo ==========================================
echo   微信聊天记录分析工具
echo ==========================================
echo.
if not exist "config.json" (
    echo 首次使用，请按以下步骤操作：
    echo 1. 复制 config.example.json 为 config.json
echo 2. 用记事本打开 config.json，填入 LLM API Key
echo 3. 如有需要，修改 dataPath 为微信数据目录
echo 4. 保存后重新运行此脚本
echo.
    notepad config.example.json
    pause
    exit /b 1
)

echo 正在启动分析...
echo.
.\node\node.exe .\dist\cli.js analyze --config config.json
echo.
if %errorlevel% neq 0 (
    echo 分析过程中出现错误，按任意键退出...
    pause
) else (
    echo 分析完成！按任意键关闭...
    pause
)
BATEOF

  # Windows 换行符转换
  if command -v unix2dos &>/dev/null; then
    unix2dos "$BUILD_DIR/运行分析.bat" 2>/dev/null || true
  fi

  echo "[6/6] 打包为 zip..."
  cd "$RELEASE_DIR"
  ZIP_NAME="wechat-analysis-portable-win.zip"
  rm -f "$ZIP_NAME"
  zip -rq "$ZIP_NAME" wechat-analysis-win/

  echo ""
  echo "✓ 打包完成！"
  echo "  文件: $RELEASE_DIR/$ZIP_NAME"
  echo "  大小: $(du -h "$RELEASE_DIR/$ZIP_NAME" | cut -f1)"
  echo ""
  echo "使用方法:"
  echo "  1. 把 zip 传到 Windows 电脑解压"
  echo "  2. 复制 config.example.json → config.json，填入 API Key"
  echo "  3. 右键'运行分析.bat' → 以管理员身份运行"
fi

# ═══════════════════════════════════════════
# 模式 B: 单 exe (pkg)
# 体积小，但 better-sqlite3 原生模块可能有问题
# ═══════════════════════════════════════════
if [[ "$MODE" == "exe" ]]; then
  echo "[3/6] 安装 pkg..."
  npm install --save-dev pkg@5 --silent

  echo "[4/6] 下载 Windows 版 better_sqlite3.node..."
  mkdir -p "$BUILD_DIR/native"
  PREBUILD_URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v108-win32-x64.tar.gz"
  curl -L --progress-bar -o "/tmp/better-sqlite3-win.tar.gz" "$PREBUILD_URL"
  tar -xzf "/tmp/better-sqlite3-win.tar.gz" -C "/tmp/"
  cp "/tmp/build/Release/better_sqlite3.node" "$BUILD_DIR/native/"
  rm -rf "/tmp/build"

  echo "[5/6] 用 pkg 打包 exe..."
  npx pkg "$PROJECT_DIR/dist/cli.js" \
    --target "$PKG_TARGET" \
    --output "$BUILD_DIR/wechat-analysis.exe" \
    --config "$PROJECT_DIR/package.json"

  echo "[6/6] 生成辅助文件..."
  cp "$PROJECT_DIR/config.example.json" "$BUILD_DIR/"
  [[ -f "$PROJECT_DIR/README.md" ]] && cp "$PROJECT_DIR/README.md" "$BUILD_DIR/"

  cat > "$BUILD_DIR/运行分析.bat" << 'BATEOF'
@echo off
chcp 65001 >nul
title 微信聊天记录分析工具
cd /d "%~dp0"

:: 设置原生模块路径
set NODE_PATH=%~dp0native

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限运行，正在申请...
    powershell -Command "Start-Process '%~f0' -Verb runAs"
    exit /b
)

if not exist "config.json" (
    echo 首次使用，请复制 config.example.json 为 config.json 并填入 API Key
    notepad config.example.json
    pause
    exit /b 1
)

wechat-analysis.exe analyze --config config.json
if %errorlevel% neq 0 pause
BATEOF

  if command -v unix2dos &>/dev/null; then
    unix2dos "$BUILD_DIR/运行分析.bat" 2>/dev/null || true
  fi

  echo "[7/6] 打包为 zip..."
  cd "$RELEASE_DIR"
  ZIP_NAME="wechat-analysis-exe-win.zip"
  rm -f "$ZIP_NAME"
  zip -rq "$ZIP_NAME" wechat-analysis-win/

  echo ""
  echo "✓ 打包完成！"
  echo "  文件: $RELEASE_DIR/$ZIP_NAME"
  echo "  大小: $(du -h "$RELEASE_DIR/$ZIP_NAME" | cut -f1)"
  echo ""
  echo "⚠ 注意: exe 模式依赖 better-sqlite3 原生模块，"
  echo "  目标电脑可能需要安装 Visual C++ Redistributable。"
  echo "  如遇到模块加载错误，请改用便携包模式: ./scripts/build-win.sh"
fi

# 清理
rm -rf "$TEMP_DIR"

echo ""
echo "========================================"
echo "  构建完成"
echo "========================================"
