; ─────────────────────────────────────────────────────────────
; SLATE Teams Windows 安装程序
; 编译：ISCC SLATE_Teams.iss（或运行 build_installer.bat）
; 带预发布版本编译：ISCC /DMyAppVersion=0.4.5-rc1 SLATE_Teams.iss
; 语言：向导第一步选择安装包语言（简体中文 / English），
;       应用界面语言在后续步骤另选（见 [Code] LangPage）
;
; 与上游 SLATE 同机共存的前提：AppId 是 GUID、必须各用各的（同一个 GUID 会被 Windows
; 当成同一个产品的升级包，装一个就卸掉另一个）；SetupMutex、自启注册表值名、
; Software\<产品> 键、默认安装目录同样都由 MyAppName 派生，改这一个变量即可分开。
; ─────────────────────────────────────────────────────────────

#define MyAppName "SLATE Teams"
; 版本号唯一事实源，允许预发布后缀：0.4.5 / 0.4.5-beta1 / 0.4.5-rc1。
; 命令行或 CI 用 /DMyAppVersion=<去掉 v 的 tag> 注入时，本行默认值不生效。
#ifdef MyAppVersion
#else
  #define MyAppVersion "0.1.0"
#endif
; VersionInfoVersion 只接受「最多四段数字点分」，后缀会让编译报 invalid，故拆出数字段；
; AppVersion、安装包文件名、产品版本仍用带后缀的完整标签。
#define MyAppVerDashPos Pos("-", MyAppVersion)
#if MyAppVerDashPos > 0
  #define MyAppNumericVersion Copy(MyAppVersion, 1, MyAppVerDashPos - 1)
#else
  #define MyAppNumericVersion MyAppVersion
#endif
; 构建号（yyyyMMddHHmm）。发布构建由 CI 用 /DMyAppBuild= 注入，本地构建用下行默认值
#ifdef MyAppBuild
#else
  #define MyAppBuild "202610051841"
#endif
#define MyAppPublisher "SLATE Teams"
#define MyAppURL "https://github.com/CaryWang1234/SLATE-Teams"
#define MyAppExeName "SLATE-Teams.exe"
#define MyAppSourceDir "dist\SLATE-Teams"
; WebView2 运行时注册表 GUID（pywebview 依赖）
#define WebView2ClientGuid "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

[Setup]
; 上游 SLATE 用的是另一个 GUID。这里绝不可以与它相同：Inno 用 AppId 认"同一个产品"，
; 撞了就是两者互相升级/卸载——装 Teams 会把 SLATE 卸掉。
AppId={{AC4EF453-CC6D-4F7B-A6EA-AE6027ECF410}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
AppComments=本地 AI 智能体平台 / Local AI Agentic Platform (Build {#MyAppBuild})
AppContact={#MyAppURL}/issues
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 默认按当前用户安装，但允许用户在向导中选择"为所有用户安装"
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; Windows 10 及以上（WebView2 要求）
MinVersion=10.0
LicenseFile=LICENSE
OutputDir=installer
OutputBaseFilename=SLATE-Teams-Setup-{#MyAppVersion}
SetupIconFile=app.ico
; 防止多个安装程序实例同时运行（与上游 SLATE 的互不阻塞）
SetupMutex=SLATETeamsSetupMutex
SetupLogging=yes
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
CloseApplications=yes
RestartApplications=no
; 版本信息（写入安装包属性页）
VersionInfoVersion={#MyAppNumericVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序 Installer (Build {#MyAppBuild})
VersionInfoProductName={#MyAppName}
VersionInfoCopyright=Copyright (c) {#MyAppPublisher}

; 安装包语言：向导第一步弹出语言选择对话框（2 种语言以上时自动出现）。
; 简体中文使用随仓库分发的官方翻译 installer\ChineseSimplified.isl；
; 列表第一项为默认预选语言。
[Languages]
Name: "chinesesimp"; MessagesFile: "installer\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

; 向导文案按语言提供：无前缀为英文（也是缺省回退），chinesesimp. 前缀为简体中文。
; 注意：覆盖内置消息名时（如 WelcomeLabel1），每种语言都要有定义，
; 否则该语言会回退使用第一种语言的定义。
[CustomMessages]
SetupWindowTitle=SLATE Teams Setup
WelcomeLabel1=Welcome to the {#MyAppName} Setup Wizard
WelcomeLabel2=This will install {#MyAppName} on your computer. It is recommended that you close all other applications before continuing.
SelectTasksLabel1=Select the additional tasks you would like Setup to perform while installing {#MyAppName}, then click Next.
SelectTasksLabel2=Which additional tasks should be performed?
ReadyLabel1=Ready to Install
ReadyLabel2=Click Install to continue with the installation, or click Back if you want to review or change any settings.
FinishedLabel=Setup has finished installing {#MyAppName} on your computer. The application may be launched by selecting the installed icons.
FinishedLabelNoIcons=Setup has finished installing {#MyAppName} on your computer.
ClickFinish=Click the Finish button to exit Setup.
TaskDesktop=Create a desktop shortcut
TaskAutostart=Auto start SLATE Teams while setup
TaskKeepData=Keep data when uninstall
GroupShortcuts=Additional shortcuts:
GroupOptions=Additional options:
GroupUninstall=Uninstall behavior:
UninstallApp=Uninstall {#MyAppName}
LaunchApp=Launch {#MyAppName}
AppLangTitle=Application Language
AppLangSub=Choose the interface language of SLATE Teams
AppLangFooter=This can be changed by reinstalling.
WebView2Msg=Microsoft Edge WebView2 runtime was not detected.%n%nThe SLATE Teams desktop window depends on it; the UI may fail to display without it.%n%nOpen the official Microsoft download page? (You can also install it later.)
UninstallDataMsg=Delete user data (chat history, custom skills, settings) as well?%n%nChoose ""No"" to keep the data and continue after reinstalling.

chinesesimp.SetupWindowTitle=SLATE Teams 安装程序
chinesesimp.WelcomeLabel1=欢迎使用 {#MyAppName} 安装向导
chinesesimp.WelcomeLabel2=安装程序将把 {#MyAppName} 安装到您的计算机。建议在继续前关闭所有其他应用程序。
chinesesimp.SelectTasksLabel1=请选择安装过程中要执行的其他任务，然后点击“下一步”。
chinesesimp.SelectTasksLabel2=需要执行哪些附加任务？
chinesesimp.ReadyLabel1=准备安装
chinesesimp.ReadyLabel2=点击“安装”开始安装；如需检查或修改设置，请点击“上一步”。
chinesesimp.FinishedLabel=安装程序已成功将 {#MyAppName} 安装到您的计算机，可通过选择安装的图标启动应用程序。
chinesesimp.FinishedLabelNoIcons=安装程序已成功将 {#MyAppName} 安装到您的计算机。
chinesesimp.ClickFinish=点击“完成”按钮退出安装程序。
chinesesimp.TaskDesktop=创建桌面快捷方式
chinesesimp.TaskAutostart=开机自动启动 {#MyAppName}
chinesesimp.TaskKeepData=卸载时保留用户数据（聊天记录 / 技能 / 设置）
chinesesimp.GroupShortcuts=附加快捷方式：
chinesesimp.GroupOptions=附加选项：
chinesesimp.GroupUninstall=卸载行为：
chinesesimp.UninstallApp=卸载 {#MyAppName}
chinesesimp.LaunchApp=启动 {#MyAppName}
chinesesimp.AppLangTitle=应用语言
chinesesimp.AppLangSub=选择 SLATE Teams 的界面语言
chinesesimp.AppLangFooter=安装完成后可通过重装更改。
chinesesimp.WebView2Msg=未检测到 Microsoft Edge WebView2 运行时。%n%nSLATE Teams 桌面窗口依赖该组件，缺少时可能无法显示界面。%n%n是否打开微软官方下载页面？（也可稍后自行安装）
chinesesimp.UninstallDataMsg=是否同时删除用户数据（聊天记录、自定义技能、设置）？%n%n选择“否”将保留数据，重新安装后可继续使用。

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktop}"; GroupDescription: "{cm:GroupShortcuts}"; Flags: checkedonce
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "{cm:GroupOptions}"; Flags: unchecked
Name: "userdata"; Description: "{cm:TaskKeepData}"; GroupDescription: "{cm:GroupUninstall}"; Flags: checkedonce

[Registry]
; 开机自启（随 autostart 任务创建，卸载时自动移除）。
; 值名必须与上游 SLATE 不同：同一个值名意味着后装的那个悄悄顶掉先装的那个的自启。
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
    ValueName: "SLATE Teams"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"""; \
    Flags: uninsdeletevalue; Tasks: autostart
; “卸载时保留用户数据”标记（供卸载程序读取）
Root: HKCU; Subkey: "Software\SLATE Teams"; \
    ValueName: "KeepUserData"; ValueType: dword; ValueData: "1"; \
    Flags: uninsdeletevalue; Tasks: userdata

[Dirs]
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\data\skills"; Flags: uninsneveruninstall
Name: "{app}\data\webview_profile"; Flags: uninsneveruninstall

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "desktop_backend.log,*.log,data\*"
Source: "{#MyAppSourceDir}\data\constitution.json"; DestDir: "{app}\data"; Flags: ignoreversion onlyifdoesntexist skipifsourcedoesntexist
; 内置 SKILL.md 技能与专家包种子：onlyifdoesntexist 在 recursesubdirs 下按逐文件生效（已实测），
; 升级安装会把用户目录里没有的新种子补进去，且不覆盖用户改过的同名文件
Source: "{#MyAppSourceDir}\data\skills\*"; DestDir: "{app}\data\skills"; Flags: ignoreversion recursesubdirs createallsubdirs onlyifdoesntexist skipifsourcedoesntexist
Source: "{#MyAppSourceDir}\data\experts\*"; DestDir: "{app}\data\experts"; Flags: ignoreversion recursesubdirs createallsubdirs onlyifdoesntexist skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallApp}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent shellexec

[InstallDelete]
; 清理旧版本 PyInstaller 产物，避免残留
Type: filesandordirs; Name: "{app}\_internal"

[UninstallDelete]
Type: files; Name: "{app}\desktop_backend.log"
Type: files; Name: "{app}\*.log"

[Code]
// ── 应用界面语言选择（与安装包语言相互独立，写入 data/language.txt） ──
var
  LangPage: TInputOptionWizardPage;
  LangZhIndex: Integer;
  LangEnIndex: Integer;

procedure InitializeWizard;
begin
  LangPage := CreateInputOptionPage(wpSelectTasks,
    ExpandConstant('{cm:AppLangTitle}'),
    ExpandConstant('{cm:AppLangSub}'),
    ExpandConstant('{cm:AppLangFooter}'),
    True, False);
  LangZhIndex := LangPage.Add('简体中文 (Chinese)');
  LangEnIndex := LangPage.Add('English (英文)');
  // 默认跟随第一步所选的安装包语言，仍可在此页另选
  if ActiveLanguage() = 'chinesesimp' then
    LangPage.Values[LangZhIndex] := True
  else
    LangPage.Values[LangEnIndex] := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  lang: String;
  langFile: String;
begin
  if CurStep = ssPostInstall then
  begin
    langFile := ExpandConstant('{app}\data\language.txt');
    // 静默升级时保留用户已有语言选择；交互式安装始终按页面选择写入
    if WizardSilent and FileExists(langFile) then
      Exit;
    if LangPage.Values[LangEnIndex] then
      lang := 'en'
    else
      lang := 'zh';
    ForceDirectories(ExpandConstant('{app}\data'));
    SaveStringToFile(langFile, lang, False);
  end;
end;

// 检测 WebView2 运行时是否已安装（pywebview 依赖）
function IsWebView2Installed: Boolean;
var
  pv: String;
begin
  Result :=
    RegQueryStringValue(HKLM,
      'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{#WebView2ClientGuid}',
      'pv', pv) and (pv <> '')
    or
    RegQueryStringValue(HKCU,
      'SOFTWARE\Microsoft\EdgeUpdate\Clients\{#WebView2ClientGuid}',
      'pv', pv) and (pv <> '');
end;

// 安装前检查：缺少 WebView2 时提示并给出下载入口
function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not IsWebView2Installed then
  begin
    if MsgBox(ExpandConstant('{cm:WebView2Msg}'),
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/',
        '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    end;
  end;
end;

// 卸载完成后：按安装时的选择决定是否清除用户数据
var
  KeepUserData: Boolean;

// 卸载程序启动时最先执行；注册表标记会在卸载过程中被删除，必须先缓存
function InitializeUninstall: Boolean;
var
  v: DWord;
begin
  Result := True;
  KeepUserData :=
    RegQueryDWordValue(HKCU, 'Software\SLATE', 'KeepUserData', v) and (v = 1);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if not KeepUserData then
    begin
      if MsgBox(ExpandConstant('{cm:UninstallDataMsg}'),
        mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(ExpandConstant('{app}\data'), True, True, True);
      end;
    end;
  end;
end;
