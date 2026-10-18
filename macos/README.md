# SLATE Teams macOS 安装包构建指南

## 系统要求

- **操作系统**: macOS 10.15 (Catalina) 或更高版本
- **架构**: Intel x86_64 或 Apple Silicon (arm64)
- **Python**: 3.9+
- **磁盘空间**: 至少 2GB 可用空间

## 前置依赖安装

```bash
# 1. 安装 Homebrew（如果尚未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. 安装 Python 3
brew install python@3

# 3. 安装 PyInstaller
pip3 install pyinstaller

# 4. 安装项目依赖
cd /path/to/SLATE Teams
pip3 install -r requirements.txt

# 5. （可选）安装 create-dmg 以创建美观的 DMG
brew install create-dmg
```

## 构建步骤

### 方式一：使用构建脚本（推荐）

```bash
chmod +x build_macos.sh
./build_macos.sh          # 自动检测版本号
./build_macos.sh 0.3.6    # 手动指定版本号
```

### 方式二：手动构建

```bash
# 1. PyInstaller 构建
pyinstaller SLATE_Teams_macos.spec --clean --noconfirm

# 2. 验证 .app 生成
ls -la dist/macos/SLATE Teams\ Teams.app/Contents/MacOS/SLATE Teams

# 3. 创建 DMG
hdiutil create \
    -volname "SLATE Teams 0.3.6" \
    -srcfolder dist/macos/SLATE Teams\ Teams.app \
    -ov \
    -format UDZO \
    dist/macos/SLATE-Teams-Setup-0.3.6.dmg
```

## 输出文件

构建成功后，在 `dist/macos/` 目录下会生成：

```
dist/macos/
├── SLATE Teams.app/              # macOS 应用程序包
├── SLATE-Teams-Setup-0.3.6.dmg      # 磁盘镜像安装包
└── SLATE-Teams-Setup-0.3.6.dmg.sha256  # SHA256 校验和
```

## 安装与运行

### 安装

1. 双击打开 `SLATE-Teams-Setup-0.3.6.dmg`
2. 将 `SLATE Teams.app` 拖入 `Applications` 文件夹
3. 弹出磁盘镜像

### 首次运行

由于应用未经过 Apple 公证，macOS Gatekeeper 可能会阻止运行。解决方法：

**方法一（推荐）**：
- 右键点击 `SLATE Teams.app` → 选择「打开」→ 在弹出的对话框中点击「打开」

**方法二**：
```bash
# 移除隔离属性（需要管理员权限）
sudo xattr -rd com.apple.quarantine /Applications/SLATE Teams\ Teams.app
```

**方法三**：
- 系统偏好设置 → 安全性与隐私 → 通用 → 允许「SLATE Teams」运行

## 代码签名与公证（发布到生产环境）

要将应用分发到非开发机器，需要进行代码签名和公证：

### 1. 获取 Apple Developer ID

在 [Apple Developer](https://developer.apple.com/) 注册并获取：
- Developer ID Application 证书
- Team ID

### 2. 导入证书到钥匙串

```bash
# 从 .p12 文件导入
security import DeveloperID_Application.p12 -k ~/Library/Keychains/login.keychain-db
```

### 3. 修改构建脚本

编辑 `build_macos.sh`，取消注释代码签名部分：

```bash
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
    "dist/macos/SLATE Teams.app"
```

### 4. 公证应用

```bash
# 上传到 Apple 进行公证
xcrun notarytool submit dist/macos/SLATE-Teams-Setup-0.3.6.dmg \
    --apple-id "your@apple.id" \
    --password "app-specific-password" \
    --team-id "YOUR_TEAM_ID" \
    --wait

#  stapler 附加公证票据
xcrun stapler staple dist/macos/SLATE-Teams-Setup-0.3.6.dmg
```

### 5. 验证签名

```bash
codesign -vvv --deep --strict dist/macos/SLATE Teams\ Teams.app
spctl --assess --type execute dist/macos/SLATE Teams\ Teams.app
```

## 故障排查

### 问题：PyInstaller 构建失败

```bash
# 清理缓存重试
rm -rf build dist __pycache__
pyinstaller SLATE_Teams_macos.spec --clean --noconfirm
```

### 问题：缺少模块错误

检查 `SLATE_Teams_macos.spec` 中的 `hiddenimports` 列表，添加缺失的模块。

### 问题：DMG 打开后无法拖拽

确保 DMG 中包含 Applications 符号链接：
```bash
ln -s /Applications dist/macos/slate-dmg-temp/Applications
```

### 问题：应用启动后立即退出

查看日志：
```bash
# 控制台日志
log show --predicate 'process == "SLATE Teams"' --last 5m

# 或直接运行可执行文件查看错误
./dist/macos/SLATE Teams\ Teams.app/Contents/MacOS/SLATE Teams
```

## 自动化 CI/CD（GitHub Actions 示例）

创建 `.github/workflows/build-macos.yml`：

```yaml
name: Build macOS Installer

on:
  push:
    tags: ['v*']

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          brew install create-dmg

      - name: Build DMG
        run: bash build_macos.sh

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: SLATE-Teams-macOS
          path: dist/macos/*.dmg
```

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.3.6 | 2026-08-29 | 初始 macOS 安装包支持 |

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](../LICENSE)。
