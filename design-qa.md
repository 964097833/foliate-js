# 第二版阅读器界面验收

final result: passed

日期：2026-10-18。范围：用户选定第二版后，Mac 网页与 iPhone App 的共用阅读界面。

## 视觉依据与对照

- 源图：[reference.png](docs/design/apple-books/reference.png)，1487 × 1058 像素生成设计稿；桌面区域约 1055px，手机 420px，中间约 12px。源图没有真实 CSS viewport 或 DPR，按设计像素理解布局，不虚构设备元数据。
- 桌面：[desktop-matched.png](docs/design/apple-books/desktop-matched.png)，CSS 1055 × 1058，PNG 1056 × 1058，DPR 约 1。宽度 1px 差来自 Chrome 90% 缩放补偿的舍入，读取实际 CSS 尺寸后捕获，未缩放字体。
- 手机：[phone-matched.png](docs/design/apple-books/phone-matched.png)，CSS 与 PNG 均为 420 × 1058，DPR 约 1。这是 Chrome 响应式截图，不是 iPhone 截图。
- 状态：纸色、24px、翻页、译文、外观面板展开。真实书籍及缓存原样保留，正文不会改写成生成稿的示例内容。
- [完整与局部对照](docs/design/apple-books/comparison.png)：同一浏览器画面包含源图与实现全图，以及桌面外观控件局部。全图等比例缩小；局部在 HTML 中按原像素裁视。对照页 CSS 766 × 759、运行时 DPR 2；截图接口按 CSS 像素归一化输出 766 × 759 PNG。
- 交互参考另核对 [Apple Books 阅读说明](https://support.apple.com/zh-cn/guide/iphone/iphc1af7c57/27/ios/27)。字体和图标来源分别见 `ui/fonts/README.md`、`ui/icons/README.md`。

## 五项视觉核对

| 表面 | 结果 |
| --- | --- |
| 字体与层级 | Mac 优先 Songti SC，iPhone 内置 Noto Serif SC 离线后备；正文默认 24px、1.55 行高、紧凑段距，保留 H1–H6 和局部粗斜体。系统字体用于控件，手机书名最多两行。不同系统的字形及抗锯齿不作逐像素等同结论。 |
| 间距与布局 | 单栏、低干扰顶部、底部胶囊工具、桌面右下浮层与手机抽屉对应选定方向。手机为至少 44px 触控目标留出空间，面板略高于稿件；桌面最大排版宽度 820px，保留真实书籍阅读密度，正文和图片自然重新分页。 |
| 颜色与状态 | 白天／纸色／夜间 token；橙色表示选中与操作。选中底色 `#c45100` 与白字对比约 4.64:1，比稿件的亮橙稍深，是可访问性调整。夜间提示框使用深灰，iPhone 系统安全区域跟随主题。 |
| 图片与图标 | 保留 EPUB 原图和比例，不用生成稿虚构插图替换书籍。Phosphor Regular 来自官方仓库并附 MIT 许可，无手绘图标或占位装饰。 |
| 文案与内容 | 使用真实书名、译文、同步和翻译设置；底部为目录、原文、双语、译文、外观、更多。书库提供继续阅读、导入与已同步书籍入口。源图示例正文不是内容契约。 |

## 发现、修复与比较历史

| 级别 | 问题与影响 | 修复和复核 |
| --- | --- | --- |
| P1，已解决 | 改变渲染区域高度使图文页比例／刷新恢复偏移。 | 恢复全视口渲染器，用阅读留白避让工具栏；真实 EPUB 图文页、嵌套框的 CFI、图片几何和缓存复用通过。早期失败记录为 `.verification/design-apple-books-2026-10-18/full-check.log`，最终报告见下。 |
| P1，已解决 | 快速滚动后立即保存或切换外观，250ms 合并前的旧可见范围可能被保存。 | `Paginator.getVisibleRange()` 同步读取画面。改变字号验证原字符的屏内垂直位置；同设备重开验证精确新位置。 |
| P2，已解决 | 窗口尺寸变化或模态焦点返回时，外壳被程序滚动，顶部离屏。 | 固定外壳并使用 `overflow: clip`；验收打开外观面板时来回切换桌面／手机宽度，最终顶部 y=0。 |
| P2，已解决 | 手机外观面板遮住阅读工具，空白较多；切换目录时可能受模态层阻挡。 | 同一套真实工具在手机面板打开时移入，关闭／切换桌面宽度时移回；收紧面板间距。最终全图与局部图复核，并在真机确认面板内打开目录可交互。 |
| P2，已解决 | iPhone 中文回退无衬线，纸色阅读面周围仍为黑色。 | 打包许可字体；原生 `setAppearance` 更新容器、WebView 与系统明暗，真机纸色／夜间截图确认。 |
| P2，已解决 | 夜间浅灰提示框和浅色字对比不足，亮橙白字对比不足。 | 只给浅色书籍表面增加主题属性，保留节点；真实书籍框颜色、宽度及切回原布局通过。选中色白字对比达到上述数值。 |

早期状态和 trace 保存在各独立验收目录；没有通过改缓存协议或放宽同设备恢复断言解决。跨设备验证原逻辑字符仍在屏内，避免将不同分页宽度下的页首字符误当同步标准。

## 功能与原生验证

- `npm run check` 通过：严格 lint、41 项 Node 测试、28 项浏览器流程、238 条模块断言、6 项故障拒绝。报告：`.verification/runs/2026-10-18T10-01-37-515Z-98932ff6/summary.json`。最后配色、存储值校验及手机模态工具切换后再次完整运行。
- 覆盖阅读模式、目录、翻页／滚动、主题／字号、局部格式、预取、缓存、刷新、切书、进程重启、原生 JS 替身、双向同步与冲突选择。原生替身另断言离线字体已加载、主题消息已发送，不据此声明 UIKit 已验证。
- 真实 Chrome 捕获错误数 0；原有 406 条缓存逐条保留，实际翻页／预取后共 415 条。恢复原逻辑段落 `21:10`、offset 0，纸色、24px 后实际刷新。
- `npm run ios:prepare` 与 iPhoneOS SDK 自动签名构建通过，覆盖安装保持原 Bundle Identifier、团队和本地数据；打包资源与源码哈希一致。
- iPhone 17 真机证据：[纸色阅读](docs/design/apple-books/iphone-paper.png)、[外观面板](docs/design/apple-books/iphone-appearance.png)、[夜间主题](docs/design/apple-books/iphone-night.png)。为 Device Hub 完整窗口截图，包含系统安全区域。翻页与终止重开记录另见 `docs/iphone-sync.md`。
- 本轮没有重复 Mac 真正关机的用户实测，没有安装模拟器运行时；此前离机记录继续见 `docs/iphone-sync.md`，不能由 Chromium 测试替代。

## 剩余项与交付清单

本节第二版视觉对照没有剩余可行动的 P0／P1／P2。P3：平台字形、示例稿与真实书籍的换行／插图位置，以及键盘焦点轮廓存在正常差异；可按长期阅读感受微调。

- 已保留真实书籍、24px 默认值、紧凑段距及原格式。
- 已完成响应式交互、焦点、触控尺寸及视觉对照。
- 已核对预取、缓存、阅读位置与同步协议兼容。
- 已打包离线字体，完成原生签名与覆盖安装。
- 继续使用现有本地服务和 iPhone App，不新增云部署或 GitHub CI。

## 三项阅读交互增量（2026-10-18）

final result: passed

范围为机主确认的沉浸阅读、阅读定位与同步面板，继续沿用第二版视觉方向、纸色、24px 和紧凑段距。不是对既有全部缺陷的修复声明。

| 场景 | 结果与证据 |
| --- | --- |
| 工具展开 | [桌面](docs/design/reading-controls/desktop-reading.png)、[手机尺寸](docs/design/reading-controls/phone-reading.png)：章节为主要上下文，书名为次要信息，底部显示当前版式的剩余页数。 |
| 沉浸阅读 | [手机尺寸](docs/design/reading-controls/phone-immersive.png)：完整收起顶部与底部工具，留白 36px，保留轻量章节／进度入口；没有继续缩小文字。修复初次视觉检查中进度条 inline visibility 使其残留的问题。 |
| 进度预览与返回 | [手机尺寸](docs/design/reading-controls/phone-preview.png)：预览仅显示目标，不提前导航。浏览器验证提交、目录跳转、30 秒返回入口、原逻辑字符与刷新；选词和章节链接不会隐藏工具。 |
| 同步面板 | [手机尺寸成功态](docs/design/reading-controls/phone-sync.png)、[桌面待同步态](docs/design/reading-controls/desktop-sync.png)：概况优先，连接设置折叠。变化立即标记待同步，提交后才显示成功；失败可重试，冲突仍显式选端。 |

上述浏览器截图均为当前运行捕获并打开核对的原始 PNG，使用隔离测试书和模拟翻译／GitHub。桌面 CSS 1280×900、手机 CSS 390×844，DPR 约 1；不是 iPhone 屏幕截图。图片与控件沿用原资源。桌面和手机状态均未见正文／控件重叠、裁切或横向溢出。

最终 `npm run check`：严格 lint、41 项 Node、33 项浏览器流程、238 条模块断言、6 类故障拒绝全部通过；报告 `.verification/runs/2026-10-18T13-32-13-376Z-a5f848cc/summary.json`。新增验收覆盖工具收放、选词／链接、章节信息、预览不触发目标翻译、目录／进度返回、缓存逐条复用、刷新与同步状态。较早失败为测试定位器无法进入封闭 Shadow DOM 的 iframe；读取自动保存状态后改为基于真实链接坐标点击，完整重跑通过，未放宽应用断言。

`npm run ios:prepare`、iPhoneOS 自动签名构建、Simulator SDK 无签名构建通过；同 Bundle Identifier／团队覆盖安装及启动成功。reader.html、reader.js、reader.css、reader-chrome.js、reader-navigation.js、reader-sync.js 在源码、打包目录和签名 App 内逐字节一致。真机可见章节与新同步面板，证据 `.verification/reader-polish-2026-10-18/iphone-conflict-final.png`；真实手机交互全流程及关机测试未在本轮重复，不由 Chrome 结果替代。

真机发现已有手机 71% 与 Mac 37% 的位置冲突，机主已选择保留 iPhone 并完成“继续本机位置”。GitHub 清单确认 iPhone 的第 14 章位置，Mac 接收后保存段落 `29:24`／offset 0 在页面内可见；446 条译文逐条一致，刷新前后 CFI、译文位置与模式完全一致。真实回验截图为 `.verification/reader-polish-2026-10-18/mac-phone-position-confirmed.png`。本轮没有改动个人书籍的缓存协议或读取密钥。
