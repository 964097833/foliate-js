> 历史验收记录：以下截图和结论来自已移除的客户端版本，不代表当前网页端验收结果。当前只维护网页端，验证方式见 README。

# 逐页翻译视觉核对

final result: blocked

## 全局配置补充验收

- 用户纠正：首页即可配置模型；应用级设置不得依赖打开书籍。
- 当前首页现场截图：`docs/design/global-settings/01-home-before-native.png`；现有首页没有设置入口，应用菜单可访问性树也无“设置…”。
- 已实现：首页常驻设置、⌘,、打开书前保存与书窗复用；最终原生截图及完整回归待核对。

## 证据与归一化

- 视觉基准：`docs/design/translation-reference.png`，用户选择的第 3 版。
- 实现：`out/Foliate Reader-darwin-arm64/Foliate Reader.app`；本地模拟模型、隔离配置、同一份样书文字。
- 基准像素：1487 × 1058；归一化为 1440 × 1024：`docs/design/translation-reference-normalized.png`。
- 主对照：1440 × 1024 CSS px，浅色、双语、当前批次完成；原生截图 2880 × 1712，原生内容区 1440 × 824，DPR 2，测试预览缩放 0.8046875。
- 主截图去除 64px 原生标题栏，取完整的约 2318 × 1648 阅读区域，再归一化至 1440 × 1024；未裁去正文留白。
- 最终截图：`docs/design/translation-implementation-native.png`、`docs/design/translation-implementation.png`。
- 全图组合：`docs/design/translation-comparison-final.png`；正文局部组合：`docs/design/translation-focus-final.png`。已直接打开组合图检查，另有独立审阅通过。
- 全图只比较双语正文与工具栏；基准的菜单展开态由独立原生截图和局部对照核对：`docs/design/translation-menu-native.png`、`docs/design/translation-menu-comparison.png`。macOS 原生菜单的弹出位置、宽度和高亮采用系统呈现，不据此判断正文尺寸。
- 补充视口：1440 × 824、600 × 500，DPR 2、scale 1；截图同样去原生标题栏，按实际 CSS 范围裁取并缩小至 1 倍。窄视口之外的原生空白不属于产品内容。

## 发现与修复历史

1. 首轮：P1 正文过小，原文 17px／译文 20px；P1 单栏宽度和顶部留白异常；P2 工具栏文字过小。
   - 证据：`translation-comparison-initial.png`、`translation-implementation-initial.png`。
   - 原因：向排版器传入的长度缺少 px，导致 grid 长度无效；字体比例也偏离基准。
   - 修复：1100px 单栏上限、80px 页边距；原文 28px／译文 34px；工具栏标题和模式 18px；无书内样式时使用衬线默认排版。
2. 第二轮：布局、字号和三组配对已恢复；P2 原文两端对齐与自动断词仍偏离基准的自然阅读节奏。
   - 证据：`translation-comparison-revised.png`、`translation-focus-revised.png`。
   - 修复：Georgia 优先后备字体，默认自然对齐，不自动断词；书内字体声明仍可覆盖前置默认样式。
3. 最终轮：重新打包、重新跑完整翻译流程、重新原生截图并组合对照；无 P0／P1／P2。三组原译文完整配对，顶部与底部控件不遮挡正文。
   - 修复后证据：`translation-comparison-final.png`、`translation-focus-final.png`。

## 五项视觉检查

| 表面 | 结果 |
| --- | --- |
| 字体与层级 | 原文 28px、灰色；译文 34px／1.55 行高、Songti SC；中文更突出。默认英文字体 Georgia 在本机存在，Times New Roman 为后备。系统字形及光栅化有轻微差别，属 P3。 |
| 间距与布局 | 单栏居中、原译文紧邻、段落间留白、轻工具栏和底部进度成立；未见重叠、横向溢出或被持续控件遮挡。较短视口自然增加分页。 |
| 颜色与状态 | Canvas 白底、正文深色、原文弱化、蓝色模式与操作按钮；键盘焦点描边可见。错误状态和重试已由真实打包应用流程验证。 |
| 素材与图标 | 基准无新增插画；保留原产品已有 SVG 图标，采用原生选择控件；无占位图或自制图形替代设计素材。书籍图片加载和保留已通过回归。 |
| 文案与内容 | 三个模式与 URL／API Key／Model 字段准确。样书正文一致；实际还翻译章节标题，且不凭空加入基准中的 CHAPTER 3 标记，属于书籍内容差异。 |

## 操作与窄窗口

- 原生 Cua：展开模式菜单、双语切换仅译文、返回双语；仅译文的可访问性树只含已完成译文，正文原文确实隐藏。
- 原生 Cua：设置菜单进入表单，已存 Key 不回填，关闭按钮和 Escape 均可返回阅读。
- 600 × 500：标题、模式、设置及底部翻页可见；设置表单可滚动到保存操作，Escape 可关闭。
- 证据：`translation-only.png`、`translation-menu.png`、`translation-settings.png`、`translation-narrow.png`、`translation-settings-narrow.png`。
- 表单标签、password 字段和键盘焦点明确；未做完整屏幕阅读器专项审计。

## 功能验证

- 最新打包应用翻译 smoke：首次配置、等价 endpoint 留空保留 Key、系统加密、bridge 隔离、三模式、原文 CFI、401／429 恢复、跨页跨章、图片与空页、HTML 文本安全、取消及重启保存均通过；无未捕获渲染异常。
- 最新 Node 测试 8／8；浏览器 CFI／翻译回归、ESLint、diff 检查通过。
- 真实 EPUB：40 个章节、35 个目录入口、194 张章节图片及桌面导航通过。
- 未使用真实 API Key，未验证真实模型服务的翻译质量、供应商差异或计费。

## 后续微调

- P3：系统字体的细微字形／字重和段间距，可在实际长篇试读后再调；不阻塞交付。
- 当前为 macOS 应用验收；深色模式、Intel 构建及完整辅助技术审计未纳入本轮视觉结论。

## 验收清单

- [x] 同尺寸全图与正文局部组合检查
- [x] P0／P1／P2 修复后重新截图
- [x] 原生模式菜单、仅译文及配置窗口核对
- [x] 窄窗口与可滚动配置操作核对
- [x] 最新构建回归与源码一致性检查
