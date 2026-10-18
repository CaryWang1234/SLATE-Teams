#!/bin/bash
# ─────────────────────────────────────────────────────────────
# SLATE Teams macOS 构建与打包脚本
# 用法：bash build_macos.sh [version]
#   version: 可选，如 "0.4.5"，默认从 InnoSetup 读取
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── 版本检测 ────────────────────────────────────────────────
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    # 尝试从 Inno Setup 脚本提取版本号
    if [ -f "SLATE_Teams.iss" ]; then
        VERSION=$(grep '#define MyAppVersion' SLATE_Teams.iss | sed 's/.*"\(.*\)".*/\1/')
    fi
fi
if [ -z "$VERSION" ]; then
    log_error "无法确定版本号，请手动传入: bash build_macos.sh 0.4.5"
fi

# 把同一个版本串（含 -rc1/-beta1 后缀）交给 SLATE_Teams_macos.spec 写进 Info.plist
export SLATE_TEAMS_APP_VERSION="${VERSION}"

BUILD_TIMESTAMP=$(date +"%Y%m%d%H%M")
APP_NAME="SLATE Teams"
BUNDLE_NAME="${APP_NAME}.app"
DMG_FILENAME="SLATE-Teams-Setup-${VERSION}.dmg"

log_info "版本: ${VERSION}"
log_info "构建时间戳: ${BUILD_TIMESTAMP}"
log_info "应用名称: ${APP_NAME}"

# ── 环境检查 ────────────────────────────────────────────────
check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "缺少必要命令: $1，请先安装 (brew install $2)"
    fi
}

check_command python3 "python@3"
check_command pip3 "python-pip"
check_command pyinstaller "pyinstaller"
check_command hdiutil ""  # macOS 自带
# create-dmg 是可选依赖，不能走 check_command：那个函数缺命令就 exit 1，而下面本来就备了
# 一条 hdiutil 的兜底路径——挂在必选检查上，等于没装 create-dmg 的机器连兜底那一支都走不到，
# 整个构建在依赖检查这一步就没了。
if ! command -v create-dmg &> /dev/null; then
    log_warn "create-dmg 未安装，将使用基础 dmg 创建方式 (brew install create-dmg)"
fi

# ── 清理旧构建 ──────────────────────────────────────────────
log_info "清理旧构建..."
rm -rf dist build
mkdir -p dist

# ── 安装依赖 ───────────────────────────────────────────────
log_info "安装 Python 依赖..."
pip3 install -r requirements.txt --quiet

# ── PyInstaller 构建 ────────────────────────────────────────
log_info "PyInstaller 构建中..."
pyinstaller SLATE_Teams_macos.spec --clean --noconfirm

if [ ! -d "dist/${BUNDLE_NAME}" ]; then
    log_error "PyInstaller 构建失败，未找到 .app 包"
fi

log_info "PyInstaller 构建完成"

# ─ 复制前端资源到 .app 内部 ────────────────────────────────
log_info "复制前端资源..."
RESOURCES_DIR="dist/${BUNDLE_NAME}/Contents/Resources"
mkdir -p "${RESOURCES_DIR}/frontend"
cp -r frontend/* "${RESOURCES_DIR}/frontend/" 2>/dev/null || true

# 复制图标
if [ -f "app.icns" ]; then
    cp app.icns "${RESOURCES_DIR}/app.icns"
else
    log_warn "未找到 app.icns，将使用默认图标"
fi

# 复制许可证
if [ -f "LICENSE" ]; then
    cp LICENSE "${RESOURCES_DIR}/LICENSE"
fi

# ── 验证 .app 结构 ──────────────────────────────────────────
log_info "验证 .app 包结构..."
if [ ! -d "dist/${BUNDLE_NAME}/Contents/MacOS" ]; then
    log_error ".app 包结构不完整"
fi

# ── 代码签名（ad-hoc）────────────────────────────────────────
# 顺序不能提前：上面刚把 frontend/、图标、LICENSE 拷进 Contents/Resources，
# 往 bundle 里再写任何文件都会让签名当场失效——签名必须是"最后一次落盘"之后的事。
#
# 为什么非签不可：未签名的 .app 下载后带上 com.apple.quarantine，Gatekeeper 直接判
# 「已损坏，无法打开」，那个对话框只有"取消 / 移到废纸篓"，连"右键 → 打开"都不给。
# ad-hoc（也就是 "-"）不需要任何证书，能把它降级成可放行的「无法验证开发者」。
#
# 升级到正式分发（需 Apple Developer 会员）：把 "-" 换成
# "Developer ID Application: <你的名字> (<TEAM_ID>)"，同时把 --timestamp=none 换成
# --timestamp（公证要求安全时间戳），之后再做 notarytool submit --wait 与 stapler staple。
log_info "代码签名（ad-hoc）..."
codesign --force --deep --sign - --timestamp=none "dist/${BUNDLE_NAME}"
if ! codesign --verify --deep --strict "dist/${BUNDLE_NAME}"; then
    log_error "签名自检失败——多半是有东西在签名之后又写进了 .app（顺序错了），别把这一版发出去"
fi
log_info "签名自检通过"

# ── 创建 DMG 安装包 ─────────────────────────────────────────
log_info "创建 DMG 安装包..."

DMG_TEMP="dist/slate-dmg-temp"
rm -rf "${DMG_TEMP}"
mkdir -p "${DMG_TEMP}"

# 复制 .app 到临时目录
cp -R "dist/${BUNDLE_NAME}" "${DMG_TEMP}/"

# 创建 Applications 文件夹快捷方式（符号链接）
ln -s /Applications "${DMG_TEMP}/Applications"

if command -v create-dmg &> /dev/null; then
    # 使用 create-dmg 创建美观的 DMG
    log_info "使用 create-dmg 创建安装包..."
    
    # 检查背景图是否存在
    BACKGROUND_ARG=""
    if [ -f "dist/dmg-background.png" ]; then
        BACKGROUND_ARG="--background dist/dmg-background.png"
    fi
    
    create-dmg \
        --volname "SLATE Teams ${VERSION}" \
        --volicon "dist/${BUNDLE_NAME}/Contents/Resources/app.icns" \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 100 \
        --icon "${BUNDLE_NAME}" 175 190 \
        --hide-extension "${BUNDLE_NAME}" \
        --app-drop-link 425 190 \
        ${BACKGROUND_ARG} \
        "dist/${DMG_FILENAME}" \
        "${DMG_TEMP}"
else
    # 基础 DMG 创建方式
    log_info "使用 hdiutil 创建基础安装包..."
    hdiutil create \
        -volname "SLATE Teams ${VERSION}" \
        -srcfolder "${DMG_TEMP}" \
        -ov \
        -format UDZO \
        "dist/${DMG_FILENAME}"
fi

# 清理临时目录
rm -rf "${DMG_TEMP}"

# ── 生成校验和 ──────────────────────────────────────────────
log_info "生成 SHA256 校验和..."
# 用子 shell 进出目录，不在脚本正文里 cd：原先 cd dist 之后配的是一步退回两级，从
# <repo>/dist 直接退到仓库的上一层，后面任何"按仓库根算"的相对路径都会落空，而 CI 正是在
# 这一步之后取产物。子 shell 里的 cd 不碰调用方的 cwd。
( cd dist && shasum -a 256 "${DMG_FILENAME}" > "${DMG_FILENAME}.sha256" )

# ── 完成 ────────────────────────────────────────────────────
log_info "=========================================="
log_info "macOS 安装包构建完成！"
log_info "=========================================="
log_info "位置: dist/${DMG_FILENAME}"
log_info "校验和: dist/${DMG_FILENAME}.sha256"
log_info ""
log_info "安装说明："
log_info "1. 双击打开 ${DMG_FILENAME}"
log_info "2. 将 ${BUNDLE_NAME} 拖入 Applications 文件夹"
log_info "3. 首次打开若被拦下（ad-hoc 签名，未公证），二选一："
log_info "   · 访达里右键（或长按）图标 → 「打开」 → 再点一次「打开」；"
log_info "   · 若看到的是「已损坏，无法打开」（这句只给「移到废纸篓」，没有「打开」按钮），"
log_info "     说明系统没吃到签名，用去隔离标记那条路："
log_info "     sudo xattr -dr com.apple.quarantine \"/Applications/${BUNDLE_NAME}\""
log_info ""
log_info "想让用户下载即开、零提示，需要 Developer ID 签名 + 公证（见上面签名一节的注释）"
log_info "=========================================="
