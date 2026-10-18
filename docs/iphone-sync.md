# iPhone 本地阅读与 GitHub 同步

Mac 使用原有本地网页和 Node 服务；iPhone 使用 Capacitor 8 / WKWebView，阅读器资源打包在 App 内。手机不访问 Mac，也不需要自建云服务器。联网翻译直接访问百炼的 HTTPS 接口；书籍、已有译文和进度通过 GitHub 私有仓库同步。

## 安装到自己的 iPhone

1. 从 Mac App Store 安装 Xcode，首次打开完成组件安装。
2. 在 Xcode → Settings → Accounts 登录自己的免费 Apple 账号。
3. 仓库根目录运行 `npm ci`、`npm run ios:prepare`、`npm run ios:open`。
4. 在 App target → Signing & Capabilities 选择自己的 Personal Team。必要时修改 Bundle Identifier 为自己的唯一名称；首次确定后保持不变，以保留本地数据与钥匙串身份。
5. 连接并信任 iPhone，在手机启用开发者模式，按提示重启后再次确认启用，选择这台设备运行 App。首次启动若提示“不受信任的开发者”，在“设置 → 通用 → VPN 与设备管理”中核对并信任自己的签名账号，再打开 App。苹果账号、验证码、设备信任和开发者模式由机主操作。
6. 在手机的“设置 → 翻译设置”填写自己的百炼 HTTPS Base URL、API Key、模型。API Key 不会从 Mac 或 GitHub 自动复制。

免费 Personal Team 的 provisioning profile 在签发 7 天后失效；届时在 Xcode 再次运行安装。更新安装时保持 Bundle Identifier 和签名团队一致，不要先删除 App；删除会丢失本地书籍、缓存及尚未上传的进度。付费会员不是本项目的必要条件。

官方说明：[免费安装与 7 天限制](https://developer.apple.com/help/account/basics/about-your-developer-account)、[Capacitor 构建环境](https://capacitorjs.com/docs/getting-started/environment-setup)。

## 配置同步

数据仓库：`964097833/foliate-reader-data`，私有，分支 `main`。它与应用源码仓库分开；尚未配置设备 Token 时不会自动上传个人书籍。

1. 在 GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens 创建 Token。
2. Repository access 仅选数据仓库；Repository permissions → Contents 设为 Read and write。Metadata 保留默认读取。选择合适的到期时间，到期后在两端更新。
3. Mac 与 iPhone 都打开阅读器顶部“同步”，填写同一个仓库、分支、Token，点击“保存并同步”。Token 直接填在设备设置中，不发送到聊天或提交到仓库。
4. 先在 Mac 上传当前书籍，看到“已同步”后，再在手机连接同一仓库。手机自动下载并恢复阅读；同步面板也可以打开以前上传的书籍。
5. 换设备前确认“已同步”。离线期间仍可读本机最后缓存的书籍及译文；新翻译和跨设备同步需要联网。恢复联网、打开 App 后重试。

GitHub Token 在 Mac 由本地服务加密保存；iPhone 存入本机 Keychain，JavaScript 只读取 `hasToken`。百炼密钥也仅保存在各设备。拒绝向公开仓库上传。私有仓库存储并非端到端加密：拥有仓库权限的人可以读取书籍和译文。

## 同步行为与边界

- 每次本地位置或模式变化先持久化待同步状态，暂停变化 15 秒后批量同步；前台每 60 秒检查，进入后台尽力提交。iOS 可能立即挂起 App，不保证后台上传完成。
- 本地缓存立即打开，网络同步在其后运行，GitHub 故障不会阻塞本地打开阅读。
- 初次连接已有仓库时恢复仓库的继续阅读位置。初次连接空仓库时上传本地当前书籍。两端已有各自待上传位置时提示冲突。
- 向量时钟确定先后，不用“阅读百分比最大”或设备时间覆盖位置。两个设备分别离线阅读时，必须选择“继续本机”或“继续另一设备”。选择远端前在本机 `foliate:sync:<repository>:<branch>:recovery` 保存恢复副本。
- manifest 使用 GitHub blob SHA 条件更新，冲突最多重试 3 次。数据块先上传，清单最后提交；中断不会发布不完整的书籍。不可变块有 SHA-256 校验，可重复使用。
- 首次上传及下载书籍显示已完成的数据块数量，随后进入译文与位置同步。下载最多 4 路并行，逐块校验并按原索引组装；失败后停止排队并等待已启动请求结束，避免迟到的进度掩盖错误。上传写入仍串行。网络慢时保持页面打开；重试会复用已上传的相同数据块，只有清单提交成功才表示整本书可供另一设备下载。
- 书籍保留 name / size / lastModified 身份，沿用已有翻译缓存键；相同键优先保留仓库已存在的译文，并合并本地新增译文。清空缓存会生成新的 cacheGeneration；其他设备丢弃旧代缓存后导入新代，避免旧译文复活。缓存不经过格式转换。
- 同步 CFI、翻译段落 key / 字符 offset、阅读模式。设备的排版流保持本机设置；跨设备不带 viewportOffset，避免 Mac 的屏幕像素偏移用于手机。同设备刷新仍保留原有精确屏幕偏移。
- 本地仍缓存最后一本书。已上传的其他书籍可从同步书库下载；单本同步上限 50 MB、单书同步译文上限 64 MB，清单上限 100 本。大书仍可按原限制在 Mac 本地阅读。目录形式和 URL 打开的书籍不自动上传。
- GitHub 历史会保留旧块与书籍；断开同步仅删除设备凭据，不删除远端数据和本地阅读数据。定期检查 Token 有效期、仓库空间、请求额度。清理历史需另行处理。

GitHub 协议：[Contents API](https://docs.github.com/en/rest/repos/contents)。创建新数据仓库时添加 README，确保选定分支存在；仓库不存在、分支错误、权限不足或限流时提示错误，保留本地进度并可重试。

### iPhone 使用已有 Clash Mi

在手机 Clash Mi 连接已有配置并保持“规则”模式，再回到阅读器同步。阅读器使用原生 URLSession 访问 `api.github.com`，无需填写 Mac 的代理地址；Mac 关机后手机代理仍可独立运行。若现有规则没有把 GitHub 指向代理，可为 `api.github.com` 添加 DOMAIN 规则，策略使用自己配置中已有的代理组。规则语法见 [Clash Mi 官方手册](https://clashmi.app/wiki/rules)。不需要修改 HTTPS 证书验证或解密请求。

“已连接”只能证明隧道启动；仍应以阅读器整本下载完成、显示“已同步”和重开后可读为准。当前原生 GitHub 请求显式绕过本地 HTTP 缓存，避免条件写入失败后再次读取旧 SHA。连接失败仅显示安全的 NSError domain/code，不显示请求地址、请求头或凭据。

## 实现入口

- `ui/reader-sync.js`：同步界面、批量调度、待同步位置、恢复和冲突选择。
- `ui/sync-protocol.js`：向量时钟、清单验证、不可变数据块、SHA 条件写入。
- `server/github-sync.js`：Mac GitHub 传输与加密配置；`server/web.js` 复用来源与 Host 检查。
- `ui/native-bridge.js`：原生翻译与同步适配器；`translation-request.js` 与 Mac 共用提示词、分段协议及模型参数。
- `ios/App/App/FoliateNativePlugin.swift`：Keychain、URLSession、取消、SHA-256 / 字体解混淆 SHA-1。禁止重定向转发密钥。
- `ios/App/App/FoliateViewController.swift` 与 `SceneDelegate.swift`：注册自定义原生插件；资源由 `scripts/prepare-ios.js` 白名单复制，保留阅读器 CSP。

## 验收与交付状态

本地入口：`npm run check`；原生资源：`npm run ios:prepare`。

安装完整 Xcode 后，先做无签名模拟器编译，再用 Personal Team 安装真机：

```sh
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -derivedDataPath out/ios-build CODE_SIGNING_ALLOWED=NO build
```

自动验收使用独立浏览器存储和模拟 GitHub / 百炼，覆盖 Mac → 手机 → Mac、局部格式、缓存命中、刷新、Mac 服务停止、离线重试、两个冲突选择。手机使用真实的 JavaScript 原生适配器，Swift Keychain / URLSession 由测试替身提供；这不是 iPhone 或 Safari 真机结论。

交付时必须分别记录：Node/浏览器结果、资源同步结果、Swift 语法解析结果、Xcode SDK 编译结果、真机安装与运行结果。缺少 Xcode 时保留工程并明确最后两项未验证，不能把语法解析说成原生编译通过。

真机验收：Mac 上传当前书籍 → 手机下载并继续 → 关闭 Mac → 手机翻页并翻译未缓存内容 → 强制关闭并重开 App → 恢复联网同步 → Mac 恢复同段文字。再验证两端离线后冲突选择、GitHub 失败保留本地进度、Token 不出现在仓库或日志中。

### 2026-10-18 本地记录

- `npm run check`：严格 lint、40 项 Node 测试、25 项浏览器流程、238 条浏览器模块断言、6 项故障拒绝探针均通过。
- 报告：`.verification/runs/2026-10-18T07-26-22-321Z-96987e66/summary.json`。
- `npm run ios:prepare`、Xcode 工程/Info.plist 结构检查、Swift 语法解析通过；完整 Xcode 未安装，SDK 编译、签名、真机安装和真实两端联通尚未验收。
- 数据仓库已确认私有，`main` 已初始化；只有 README，尚无个人书籍或译文。设备 Token 尚未配置。Mac 开机启动服务已重载，健康检查与 `/api/sync/settings` 正常。

### 同日安装与真实同步补验

- Xcode 27.1 已从苹果开发者官网下载、解包并安装至 `/Applications/Xcode.app`，`codesign --verify --deep --strict` 通过；机主已完成 Xcode / Apple SDK 许可协议和初始化认证。
- iOS 27.1 Simulator SDK 与 iPhoneOS SDK 的 Debug 无签名编译均通过，包含 Capacitor 8.5.3 和自定义 Swift 插件。依赖使用独立目录 `out/ios-packages`、`-disablePackageRepositoryCache` 解析；生成共享 `Package.resolved`。构建日志保存在 `.verification/iphone-install-2026-10-18/xcode-{simulator,device}-build.log`。
- iPhone 已配对，机主已登录 Apple 账号并选择 Personal Team；iPhoneOS Debug 自动签名构建通过，日志为 `.verification/iphone-install-2026-10-18/xcode-signed-build.log`。工程保留首次安装使用的团队与 Bundle Identifier，后续覆盖安装需保持一致。
- 开发者模式首次未生效时，安装报 CoreDevice 12040/12052、Cryptex developer mode is not enabled；机主再次确认启用并重连后，DDI 可用，`devicectl device install app` 已成功安装 `com.personal.foliatereader`。首次启动屏幕显示“不受信任的开发者”，等待机主在手机信任自己的签名账号；App 正常运行及真实手机同步尚未验收。当前未安装模拟器运行时，编译不代表模拟器实际运行验收。
- Mac 已配置仅限私有数据仓库的 Token，首次真实同步完成：书籍 12,260,755 字节、52 个数据块，394 条远端译文与本机逐条一致。重新读取远端清单，续读段落、字符 offset 和阅读模式一致。同设备刷新后仍保留原段落及 394 条缓存。
- 首次同步补充逐块进度及译文/位置阶段提示；传输协议、数据块哈希和缓存内容保持不变。
- `npm run check` 再次通过：40 项 Node 测试、25 项浏览器流程、238 条模块断言、6 项故障拒绝探针及严格 lint。报告：`.verification/runs/2026-10-18T07-52-27-696Z-53c15946/summary.json`；`npm run ios:prepare` 通过。
- 此记录仅证明真实 Mac → GitHub 数据联通，未证明 iPhone 原生网络、Mac 真正关机后的阅读翻译或跨设备回传。
- 机主已完成手机开发者信任，App 可启动并允许联网。真机首次首页发现绝对定位工具栏被 WebView / 系统安全区域遮挡；`FoliateViewController` 将 WebView 约束在原生 safeAreaLayoutGuide 内，并关闭重复的滚动安全区调整。签名编译、覆盖安装与真机截图确认“同步/设置”入口可见、同步面板可打开；临时布局诊断代码已移除。等待机主填写手机 GitHub Token 和百炼 Key 后继续真实手机阅读、翻译及双向同步验收。
- 手机凭据已由机主保存，原生请求可读取私有仓库清单。但 4 路下载版本本轮只完成 3/52 块即返回“无法连接 GitHub”。原提示合并了网络、响应类型和解析错误，单凭该提示不能确定是网络超时；继续通过安全的 NSError domain/code 区分失败来源。换网络仅用于对照排查。本轮尚未完整打开书籍，不能记为手机阅读或同步验收通过。模拟器目标编译与真机目标签名编译通过。
- 下载进度与并发回归新增后，`npm run check` 通过：41 项 Node 测试、25 项浏览器流程、238 条模块断言、6 项故障探针及严格 lint。报告：`.verification/runs/2026-10-18T08-54-43-478Z-416bb807/summary.json`。
- 后续原生诊断确认失败为 `NSURLErrorDomain/-1005`（传输中连接中断），并非已证明超时。手机已有 Clash Mi 当时未连接；启用原配置的“规则”模式后，整本 52 块下载完成，新完成的数据块请求多为 0–2 秒、HTTP 200。手机显示“已同步”，自动打开书籍与中文；覆盖安装并终止/重启 App 后恢复同一段中文和插图。未新增 VPN 配置、代理订阅或证书。
- 读取手机 App 自有 WebKit 数据快照核对：1 本书、394 条原有译文；394 条 key / text 均与 Mac 对照一致。Mac 本地服务通过 `launchctl bootout` 暂停，HTTP 请求确认不可达；手机连续翻页、进入未缓存第 8 章并直接完成百炼翻译，缓存增加至 401 条。随后恢复 Mac LaunchAgent。此项验证服务独立性，不等于 Mac 真正断电测试。
- 手机回传曾反复提示“另一设备正在同步”；原生 GitHub 请求增加 `reloadIgnoringLocalCacheData` 与 `Cache-Control: no-cache` 后重新签名覆盖安装，手机显示“已同步”；Mac 接收手机第 8 章的段落 key / offset，缓存合并至 406 条。临时 HTTP 耗时打印已移除。保留分类后的安全错误提示、下载进度与四路下载。
- 真机检查同时发现夜间模式下书籍自带浅色提示框与白色文字对比不足，章节边界有一页空白；本轮未将其记为版式完整验收通过。Mac 真正关机、脱离 USB 后的手机实测尚需机主完成。
- 最终两端缓存均为 406 条，手机 IndexedDB 快照中 406 条 key / text 与 Mac 全部匹配。Mac 已还原测试前的 CFI、翻译段落 key 和 offset；手机随后自动回到原来的旱灾段落与插图。Mac 显示“已同步”，新增译文保留。证据为 `.verification/iphone-install-2026-10-18/phone-roundtrip-result.json` 及两端 `*-restored-after-roundtrip.png`。
- 清理诊断后的 `npm run check` 全部通过：41 项 Node 测试、25 项浏览器流程、238 条模块断言、6 项故障探针及严格 lint；报告 `.verification/runs/2026-10-18T09-08-30-404Z-3750f160/summary.json`。最终 iPhoneOS 签名构建、覆盖安装、重开验收及 Simulator SDK 无签名编译通过；`git diff --check` 通过。

### 真正关机后的机主实测与 Mac 回验

- 机主按要求拔掉数据线、关闭 Mac、保持手机 Clash Mi 已连接后，确认“关机后阅读、重开续读和同步都正常”。此结论来自机主离机实测；未将其表述为工具直接观察。未缓存新翻译的工具证据仍为前述 Mac 服务停止期间的手机直连百炼验证。
- Mac 恢复后，本地阅读服务可访问，阅读器显示“已同步”。重新读取 GitHub 清单，最后位置由 `iPhone / iPad` 上传，进度约 43%。手机最后阅读段落 `21:12` 的字符 offset 27 在 Mac 当前页面范围内；不同屏幕的分页起点和页首 CFI 不相同，不能把页首 CFI 或页首段落完全相等作为跨设备续读判断。
- GitHub 406 条译文逐条 key / text 与 Mac 的 406 条缓存一致，远端对象 SHA-256 校验通过。保留机主离机测试后的新位置，没有还原到此前的测试起点。证据：`.verification/iphone-install-2026-10-18/shutdown-result.json`、`mac-shutdown-anchor-check.json` 和 `mac-after-shutdown.json`。
- 本轮仅补充验收记录，无应用源码改动，未重复运行完整测试；沿用前一轮已通过的完整验收与原生构建结果。
