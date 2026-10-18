# Repository Guidelines

## 维护范围

本仓库供个人在 Mac 网页端与 iPhone 本地 App 阅读。Mac 保留网页阅读器和本地 HTTP 服务；iPhone 内置同一阅读器，须在 Mac 关机后独立阅读和翻译，通过 GitHub 私有仓库同步书籍、译文和位置。Electron 桌面客户端已移除。

## 项目结构与模块职责

`reader.html`、`reader.js` 和 `ui/` 构成网页阅读器；`server/` 提供本地 HTTP 服务、翻译和加密配置存储。

格式适配位于根目录的 `epub.js`、`mobi.js`、`fb2.js`、`comic-book.js` 和 `pdf.js`；`view.js` 整合加载与渲染；`paginator.js` 和 `fixed-layout.js` 分别处理流式排版与固定版式。新增格式或修改渲染接口时，先阅读 `README.md` 的 book、renderer 接口说明。

`tests/` 包含 Node 测试和浏览器模块回归，`tests/browser/` 是自动浏览器验收；`rollup/` 为依赖打包入口，`vendor/` 为依赖产物及 PDF.js 资源。

## 开发与验证

运行与检查命令以 `package.json` 的 scripts 为准。日常使用 `npm start` 启动网页端；交付前运行 `npm run check`，在本地执行严格 lint、Node 测试、浏览器验收及故障拒绝验证。本项目不配置 GitHub CI。首次安装和浏览器依赖准备见 `README.md` 的 Verification。

浏览器直接加载原生 ES 模块，普通源码修改无需构建。更新打包依赖后运行 `npm run build` 并检查 `vendor/` 差异。

修改翻译协议、缓存键或书签时，先查 `docs/translation-design.md` 的代码入口与协议链路。验收入口、就绪信号、报告和失败排查见 `docs/web-verification.md` 的本地验收工具；复用独立端口、临时数据和模拟模型夹具。新增格式或渲染行为还需验证代表性书籍；浏览器异常先查自动保存的状态、截图和 trace，再用 Chrome 对照。

Node 测试加入 `npm test` 的入口；浏览器模块回归从 `tests/tests.js` 导入，完整阅读流程加入 `tests/browser/*.spec.js`。CFI 回归放入 `tests/epubcfi-tests.js`。

修改 iPhone 原生接口、打包或跨设备同步，或排查真机布局、联网和续读时，先读 `docs/iphone-sync.md` 的安装、协议边界、Clash Mi 用法与真机验收记录。联网故障先核对安全错误码和实际请求结果，再通过现有代理或换网对照定位原因。

跨设备续读以源设备最后阅读段落及字符 offset 在目标页面内可见为准；屏幕不同会改变分页和页首 CFI。译文同步保留现有缓存键，逐条核对 key / text，保留同设备精确恢复行为。使用实际书籍验收前保存阅读位置，结束后恢复；机主继续阅读后的新进度予以保留。

浏览器替身测试、原生编译和真机运行分别报告；停服测试与真正关机测试、工具观察与机主确认分别记录。手机独立运行验收覆盖缓存阅读、未缓存新翻译、重开续读和双向同步。

## 代码与提交

代码风格以 `eslint.config.js` 为准。相对导入显式包含 `.js` 扩展名；模块文件使用小写连字符命名。

提交标题沿用简短祈使句，可加子系统前缀。每次提交聚焦同一目的；拉取请求说明行为变化、关联 issue 和验证结果，缺陷修复附复现步骤，可见界面变化附截图。记录实际执行的本地验证结果。

## 内容安全

修改阅读器嵌入或资源加载逻辑时，先阅读 `README.md` 的 Security 并保留 CSP 防护。书籍内容按不可信输入处理；本库不支持 EPUB 内嵌脚本。

同步与翻译诊断按需采集状态、耗时和脱敏错误码。GitHub API 响应先筛选所需字段；凭据、Authorization 和含临时凭据的下载 URL 不进入日志、截图或仓库。
