# Repository Guidelines

## 项目结构与模块职责

源码位于仓库根目录。`epub.js`、`mobi.js`、`fb2.js`、`comic-book.js` 和 `pdf.js` 负责格式适配；`view.js` 整合加载与渲染；`paginator.js` 和 `fixed-layout.js` 分别处理流式排版与固定版式。新增格式或修改渲染接口时，先阅读 `README.md` 中的 book、renderer 接口说明。

`reader.html`、`reader.js` 和 `ui/` 构成演示阅读器；`tests/` 存放浏览器测试；`rollup/` 存放依赖打包入口；`vendor/` 存放依赖产物及 PDF.js 字体、字符映射等资源。

## 开发与构建命令

- `npm ci`：按锁文件安装依赖。
- `python3 -m http.server 8000 --bind 127.0.0.1`：启动静态服务；访问 `http://localhost:8000/reader.html` 使用演示阅读器。
- `npm run build`：打包 zip.js、fflate，并将 PDF.js 资源复制到 `vendor/`。更新依赖后检查生成文件的差异。
- `npx eslint@9.28.0 .`：使用当前 CI 指定版本执行检查；可加 `--fix` 自动修复，随后检查差异。CI 版本以 `.github/workflows/eslint.yml` 为准。

浏览器直接加载原生 ES 模块，普通源码修改无需构建。测试通过下述浏览器入口运行，仓库未配置 `npm test`。

## 代码风格与命名

遵循 `eslint.config.js`：四空格缩进、省略分号、使用单引号，多行结构保留尾随逗号。相对导入显式包含 `.js` 扩展名。函数和变量使用 camelCase，类使用 PascalCase，模块文件使用小写连字符命名，例如 `text-walker.js`。模块间通过文档约定的接口协作。

## 测试与验证

测试使用浏览器 API 和 `console.assert`，未引入测试框架或覆盖率门槛。启动静态服务后，访问 `http://localhost:8000/tests/tests.html`，确认控制台没有断言失败或模块加载错误。

CFI 修改在 `tests/epubcfi-tests.js` 中补充回归用例；新增测试文件按 `<module>-tests.js` 命名，并从 `tests/tests.js` 导入。修改格式解析或渲染时，还需在演示阅读器中打开对应格式的代表性书籍，验证导航及受影响行为。

## 提交与拉取请求

沿用历史中的简短祈使句标题，可加子系统前缀，例如 `EPUB: support multiple publishers`；现有历史未统一采用 Conventional Commits。每次提交聚焦同一目的。拉取请求说明行为变化、关联 issue，并记录 ESLint 与浏览器验证结果；缺陷修复附复现步骤，可见界面变化附截图。

## 内容安全

修改阅读器嵌入或资源加载逻辑时，先阅读 `README.md` 的 Security 章节，并保留其中要求的 CSP 防护。书籍内容按不可信输入处理；本库不支持 EPUB 内嵌脚本。
