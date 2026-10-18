# iPhone 本地阅读与 GitHub 同步

Mac 使用原有本地网页和 Node 服务；iPhone 使用 Capacitor 8 / WKWebView，阅读器资源打包在 App 内。手机不访问 Mac，也不需要自建云服务器。联网翻译直接访问百炼的 HTTPS 接口；书籍、已有译文和进度通过 GitHub 私有仓库同步。

## 安装到自己的 iPhone

1. 从 Mac App Store 安装 Xcode，首次打开完成组件安装。
2. 在 Xcode → Settings → Accounts 登录自己的免费 Apple 账号。
3. 仓库根目录运行 `npm ci`、`npm run ios:prepare`、`npm run ios:open`。
4. 在 App target → Signing & Capabilities 选择自己的 Personal Team。必要时修改 Bundle Identifier 为自己的唯一名称；首次确定后保持不变，以保留本地数据与钥匙串身份。
5. 连接并信任 iPhone，在手机启用开发者模式，选择这台设备运行 App。苹果账号、验证码、设备信任和开发者模式由机主操作。
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
- 书籍保留 name / size / lastModified 身份，沿用已有翻译缓存键；相同键优先保留仓库已存在的译文，并合并本地新增译文。清空缓存会生成新的 cacheGeneration；其他设备丢弃旧代缓存后导入新代，避免旧译文复活。缓存不经过格式转换。
- 同步 CFI、翻译段落 key / 字符 offset、阅读模式。设备的排版流保持本机设置；跨设备不带 viewportOffset，避免 Mac 的屏幕像素偏移用于手机。同设备刷新仍保留原有精确屏幕偏移。
- 本地仍缓存最后一本书。已上传的其他书籍可从同步书库下载；单本同步上限 50 MB、单书同步译文上限 64 MB，清单上限 100 本。大书仍可按原限制在 Mac 本地阅读。目录形式和 URL 打开的书籍不自动上传。
- GitHub 历史会保留旧块与书籍；断开同步仅删除设备凭据，不删除远端数据和本地阅读数据。定期检查 Token 有效期、仓库空间、请求额度。清理历史需另行处理。

GitHub 协议：[Contents API](https://docs.github.com/en/rest/repos/contents)。创建新数据仓库时添加 README，确保选定分支存在；仓库不存在、分支错误、权限不足或限流时提示错误，保留本地进度并可重试。

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
