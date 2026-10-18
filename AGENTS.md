# Repository Guidelines

## 维护范围

本仓库用于个人在本机浏览器中阅读。唯一应用入口是网页阅读器和本地 HTTP 翻译服务；新增功能、缺陷修复与验收都围绕网页端展开。Electron 客户端已移除，不再维护或重新引入桌面客户端、桌面打包和桌面专属入口。

## 项目结构与模块职责

`reader.html`、`reader.js` 和 `ui/` 构成网页阅读器；`server/` 提供本地 HTTP 服务、翻译和加密配置存储。

格式适配位于根目录的 `epub.js`、`mobi.js`、`fb2.js`、`comic-book.js` 和 `pdf.js`；`view.js` 整合加载与渲染；`paginator.js` 和 `fixed-layout.js` 分别处理流式排版与固定版式。新增格式或修改渲染接口时，先阅读 `README.md` 的 book、renderer 接口说明。

`tests/` 包含 Node 测试和浏览器模块回归，`tests/browser/` 是自动浏览器验收；`rollup/` 为依赖打包入口，`vendor/` 为依赖产物及 PDF.js 资源。

## 开发与验证

运行与检查命令以 `package.json` 的 scripts 为准。日常使用 `npm start` 启动网页端；交付前运行 `npm run check`，在本地执行严格 lint、Node 测试、浏览器验收及故障拒绝验证。本项目仅供个人本地使用，不配置 GitHub CI。首次安装和浏览器依赖准备见 `README.md` 的 Verification。

浏览器直接加载原生 ES 模块，普通源码修改无需构建。更新打包依赖后运行 `npm run build` 并检查 `vendor/` 差异。

修改阅读定位、翻译、缓存或恢复逻辑时，阅读 `README.md` 的 Verification 和 `docs/web-verification.md`；复用独立端口、临时数据和模拟模型的测试夹具。以 Chromium 自动验收为门槛，新增格式或渲染行为还需打开对应格式的代表性书籍验证。内置浏览器异常先保存原始栈、脚本来源和 iframe 文档状态，再用相同样本在 Chrome 对照定位归属。

Node 测试加入 `npm test` 的入口；浏览器模块回归从 `tests/tests.js` 导入，完整阅读流程加入 `tests/browser/*.spec.js`。CFI 回归放入 `tests/epubcfi-tests.js`。

## 代码与提交

代码风格以 `eslint.config.js` 为准。相对导入显式包含 `.js` 扩展名；模块文件使用小写连字符命名。

提交标题沿用简短祈使句，可加子系统前缀。每次提交聚焦同一目的；拉取请求说明行为变化、关联 issue 和验证结果，缺陷修复附复现步骤，可见界面变化附截图。记录实际执行的本地验证结果。

## 内容安全

修改阅读器嵌入或资源加载逻辑时，先阅读 `README.md` 的 Security 并保留 CSP 防护。书籍内容按不可信输入处理；本库不支持 EPUB 内嵌脚本。
