# 本机电子书测试样本

`how-an-economy-grows.epub` 是用户提供的《How an Economy Grows and Why It Crashes》，作者为 Peter D. Schiff 和 Andrew J. Schiff。文件从本机 Downloads 复制，内容未修改。

- 大小：12,260,755 字节。
- SHA-256：`9658ec44aac8eec3b262024791878623bd89a6f13a9414feb210391b7a1a755c`。
- 结构：40 个阅读分节，35 个目录项，196 个图片资源。

在 macOS 上先执行 `npm run package:mac`，再从仓库根目录运行：

```sh
npm run test:mac -- tests/fixtures/how-an-economy-grows.epub
```

测试会启动打包后的 `.app`，验证打开书籍、逐项目录跳转、章节图片加载、翻页及文件选择打开。测试样本随 `tests/` 一起排除在应用安装包之外。

本机验证结果：35 个目录项全部跳转成功，相关章节的 194 张图片全部加载成功；另通过原生 `⌘O` 打开流程确认 SVG 封面、目录、正文图文和翻页进度正常。
