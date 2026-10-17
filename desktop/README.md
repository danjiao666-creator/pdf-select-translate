# Windows 应用

应用版与 Chrome / Edge 插件共用同一套 PDF 阅读、翻译、文档库和文章对话代码。应用不依赖已安装的浏览器，也不需要运行本地服务器。

## 使用

- 推荐免安装包 `PaperTranslator-Portable-1.3.0-x64.zip`。解压后保留整个 `PaperTranslator` 文件夹，运行其中的 `PaperTranslator.exe`，不能只复制单个 EXE。
- 本机 Electron 运行时在 OneDrive 的中文目录中启动会异常退出。已经用独立最小程序复现，不是 PDF 数据损坏。请把运行目录放在非 OneDrive 的英文路径，例如 `%LOCALAPPDATA%\Programs\PaperTranslator`；桌面可以保留中文快捷方式。
- 安装包 `PaperTranslator-Setup-1.3.0-x64.exe` 默认安装到当前用户的 `%LOCALAPPDATA%\Programs\PaperTranslator`，不需要管理员权限。不设置浏览器或 PDF 默认关联。
- 应用尚未购买 Windows 代码签名证书，系统可能显示未知发布者提示。不要为此关闭安全软件。
- 通过「打开 PDF」、拖入窗口、将 PDF 拖到快捷方式或 `PaperTranslator.exe "C:\path\paper.pdf"` 打开文章。再次启动会使用现有应用窗口。
- 设置与文档库保存在 `%APPDATA%\文献翻译器`。免安装版也使用这一数据目录，不会把文章写入安装目录。升级应用时不删除文档库。
- 应用和插件的数据分别保存。文档库备份用于转移 PDF、译文、笔记和对话；API Key 不进入备份或分发包，需在另一端单独填写。

## 安全边界

- 阅读窗口 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`，无通用文件读取或 IPC 执行接口。
- 自定义协议只提供应用的 `src/`、pdf.js 资源和图标；设置文件、后端、开发目录与密钥文件不可通过该协议读取。
- 共享后台在独立 Worker 运行。HTTP/S 请求经 Electron 网络层处理，遵循系统代理并支持流式响应、取消和超时；渲染窗口只能发送明确允许的业务消息。
- API Key 通过 Windows 系统加密保存。不加密则拒绝保存，不退回明文。读取设置和广播设置变化均不回显 Key。
- 外部网页/邮件链接必须确认后交给系统应用，不允许文件链接、脚本链接、页面跳转或任意新窗口。
- 导出文件通过原生保存对话框选择位置；关闭窗口会等待任务确认和本地保存。
- 仅开发模式显式传入 `--developer-config=绝对路径` 时允许加载本机 API 配置，安装包中忽略此参数。默认不会自动读取源码目录的真实 Key。

## 开发与验收

依赖锁定 Electron 44.8.0、electron-builder 26.15.3；44.8.0 是本次构建时官方稳定分支版本。没有运行时自动更新下载。

```powershell
npm ci
npm run desktop
npm run desktop:dir
npm run desktop:build
node --test dev/test/desktop-unit.mjs
node dev/test/desktop.mjs
```

`desktop:build` 输出安装包和包含 ASCII 顶层目录的免安装 ZIP；不公开发布。

桌面测试会把被测运行目录复制到新建的英文临时目录，并创建独立用户数据，避免污染真实应用或插件。测试覆盖实际 EXE 的 PDF 入口、离线阅读、文档库、设置、加密、文章对话、流式消息、401、停止与关闭确认。受控 API 数据仅证明功能链路，不证明真实模型翻译质量。测试截图位于忽略目录 `dev/test/artifacts/`。

`npm run desktop` 自动将开发运行时缓存至 `%LOCALAPPDATA%\PaperTranslatorDev`，使用独立开发数据，不修改正式应用或插件。可设置 `DESKTOP_SOURCE=1` 运行源码版隔离桌面测试。发布仍需重建应用并对最新 EXE 验证，不以源码测试替代。
