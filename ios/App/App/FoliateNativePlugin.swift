import Foundation
import Capacitor
import Security
import CryptoKit

// Credentials never leave Keychain through the JavaScript bridge. Native requests
// target only the configured translation service or api.github.com.
@objc(FoliateNativePlugin)
public final class FoliateNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FoliateNativePlugin"
    public let jsName = "FoliateNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "settings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "github", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "digest", returnType: CAPPluginReturnPromise),
    ]
    private let lock = NSLock()
    private var tasks: [String: URLSessionDataTask] = [:]
    private let noRedirect = NoRedirect()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 100
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: config, delegate: noRedirect, delegateQueue: nil)
    }()
    private func query(_ scope: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.personal.foliatereader.credentials",
         kSecAttrAccount as String: scope]
    }
    private func load(_ scope: String) throws -> [String: Any] {
        var q = query(scope)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess, let data = result as? Data,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw failure("无法读取钥匙串配置，请重新保存。")
        }
        return value
    }
    private func store(_ scope: String, _ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        let status = SecItemUpdate(query(scope) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query(scope)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
                throw failure("无法保存钥匙串配置。")
            }
        } else if status != errSecSuccess { throw failure("无法更新钥匙串配置。") }
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "Foliate", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
    @objc public func settings(_ call: CAPPluginCall) {
        do {
            guard let scope = call.getString("scope"), ["translation", "sync"].contains(scope),
                  let method = call.getString("method"), ["GET", "PUT", "DELETE"].contains(method) else {
                throw failure("配置请求无效。")
            }
            var value = try load(scope)
            if method == "DELETE" {
                let result = SecItemDelete(query(scope) as CFDictionary)
                guard result == errSecSuccess || result == errSecItemNotFound else { throw failure("无法删除配置。") }
                value = [:]
            }
            if method == "PUT" {
                guard let input = call.getObject("input") else { throw failure("配置无效。") }
                if scope == "translation" {
                    var raw = (input["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    while raw.hasSuffix("/") { raw.removeLast() }
                    if raw.hasSuffix("/chat/completions") { raw = String(raw.dropLast(17)) }
                    guard let url = URL(string: raw), url.scheme == "https", url.host != nil,
                          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                          raw.count <= 2048 else { throw failure("手机翻译地址须使用完整 HTTPS URL。") }
                    let model = (input["model"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !model.isEmpty, model.count <= 200, !model.contains("\n") else { throw failure("模型名称无效。") }
                    let key = (input["apiKey"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if key.isEmpty && (value["url"] as? String != raw || value["apiKey"] == nil) {
                        throw failure("请填写 API Key；更换地址时需要重新填写。")
                    }
                    if !key.isEmpty { value["apiKey"] = key }
                    value["url"] = raw; value["model"] = model
                } else {
                    let repo = (input["repository"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let branch = (input["branch"] as? String ?? "main").trimmingCharacters(in: .whitespacesAndNewlines)
                    guard matches(repo, "^[\\w-]+/[\\w.-]+$"), repo.split(separator: "/").last != "..",
                          matches(branch, "^[\\w./-]{1,100}$"), !branch.contains("..") else { throw failure("仓库或分支无效。") }
                    let token = (input["token"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if token.isEmpty && (value["repository"] as? String != repo || value["token"] == nil) {
                        throw failure("首次配置或更换仓库时请填写 GitHub Token。")
                    }
                    if !token.isEmpty { value["token"] = token }
                    value["repository"] = repo; value["branch"] = branch
                }
                for field in ["token", "apiKey"] {
                    if let secret = value[field] as? String,
                       secret.count > 8192 || secret.contains("\n") || secret.contains("\r") { throw failure("密钥无效。") }
                }
                try store(scope, value)
            }
            if scope == "translation" {
                call.resolve(["url": value["url"] as? String ?? "", "model": value["model"] as? String ?? "",
                              "hasKey": value["apiKey"] != nil])
            } else {
                call.resolve(["repository": value["repository"] as? String ?? "", "branch": value["branch"] as? String ?? "main",
                              "hasToken": value["token"] != nil])
            }
        } catch { call.reject(error.localizedDescription) }
    }
    @objc public func digest(_ call: CAPPluginCall) {
        guard let base64 = call.getString("base64"), let data = Data(base64Encoded: base64), data.count <= 1024 * 1024 else {
            call.reject("校验内容无效。"); return
        }
        let algorithm = call.getString("algorithm") ?? "SHA-256"
        guard ["SHA-256", "SHA-1"].contains(algorithm) else { call.reject("校验算法无效。"); return }
        let hash = algorithm == "SHA-1"
            ? Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
            : SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        call.resolve(["hash": hash])
    }
    @objc public func cancel(_ call: CAPPluginCall) {
        if let id = call.getString("id") { lock.lock(); tasks[id]?.cancel(); lock.unlock() }
        call.resolve()
    }
    private func request(_ request: URLRequest, id: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            self?.lock.lock(); self?.tasks.removeValue(forKey: id); self?.lock.unlock()
            if let error = error { completion(.failure(error)); return }
            guard let http = response as? HTTPURLResponse, let data = data, data.count <= 2 * 1024 * 1024 else {
                completion(.failure(self?.failure("响应无效或过大。") ?? NSError(domain: "Foliate", code: 1))); return
            }
            do {
                let json = try JSONSerialization.jsonObject(with: data)
                completion(.success(["status": http.statusCode, "data": json]))
            } catch { completion(.failure(error)) }
        }
        lock.lock()
        if tasks[id] != nil { lock.unlock(); completion(.failure(failure("请求编号重复。"))); return }
        tasks[id] = task
        lock.unlock()
        task.resume()
    }
    private func githubFailure(_ error: Error) -> String {
        let value = error as NSError
        // Never surface userInfo, request URLs, or localized descriptions that can
        // contain credentials. Preserve only the system's error category and code.
        let domain = String(value.domain.filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" }.prefix(64))
        let code = "（\(domain)/\(value.code)）"
        if value.domain == NSURLErrorDomain {
            if value.code == URLError.timedOut.rawValue { return "GitHub 请求超时\(code)，请重试。" }
            return "GitHub 网络请求失败\(code)，请检查连接后重试。"
        }
        if value.domain == NSCocoaErrorDomain { return "GitHub 响应解析失败\(code)，请重试。" }
        return "GitHub 同步请求失败\(code)，本地数据已保留。"
    }
    @objc public func translate(_ call: CAPPluginCall) {
        do {
            let settings = try load("translation")
            guard let base = settings["url"] as? String, let url = URL(string: base + "/chat/completions"),
                  url.scheme == "https", let key = settings["apiKey"] as? String,
                  let id = call.getString("id"), matches(id, "^[\\w-]{1,128}$"),
                  var body = call.getObject("body") else { throw failure("请先配置手机翻译服务。") }
            body["model"] = settings["model"] as? String ?? ""
            body["stream"] = false
            let data = try JSONSerialization.data(withJSONObject: body)
            guard data.count <= 1024 * 1024 else { throw failure("翻译内容过长。") }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"; req.httpBody = data
            req.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request(req, id: id) { result in
                switch result {
                case .success(let value): call.resolve(value)
                case .failure: call.reject("无法完成翻译，请检查网络后重试。")
                }
            }
        } catch { call.reject(error.localizedDescription) }
    }
    @objc public func github(_ call: CAPPluginCall) {
        do {
            let settings = try load("sync")
            guard let repo = settings["repository"] as? String, let branch = settings["branch"] as? String,
                  let token = settings["token"] as? String, let method = call.getString("method"),
                  ["GET", "PUT"].contains(method), let path = call.getString("path"),
                  matches(path, "^reader-sync/(manifest\\.json|objects/[a-f0-9]{64}\\.json)$") else { throw failure("同步请求或配置无效。") }
            let base = "https://api.github.com/repos/" + repo
            func authorized(_ url: URL) -> URLRequest {
                // A manifest read must observe the current GitHub SHA after a
                // conditional write fails, rather than retrying a cached version.
                var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
                req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
                req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
                req.setValue("Foliate-Personal-Reader", forHTTPHeaderField: "User-Agent")
                return req
            }
            request(authorized(URL(string: base)!), id: UUID().uuidString) { [weak self] info in
                guard let self = self else { return }
                if case .failure(let error) = info { call.reject(self.githubFailure(error)); return }
                guard case .success(let result) = info, result["status"] as? Int == 200,
                      let data = result["data"] as? [String: Any], data["private"] as? Bool == true else {
                    call.reject("无法访问私有仓库，请检查仓库、权限及网络。"); return
                }
                var components = URLComponents(string: base + "/contents/" + path)!
                if method == "GET" { components.queryItems = [URLQueryItem(name: "ref", value: branch)] }
                var req = authorized(components.url!)
                req.httpMethod = method
                if method == "PUT" {
                    guard let content = call.getString("content"), content.count <= 800000,
                          self.matches(content, "^[A-Za-z0-9+/=]*$") else { call.reject("同步内容无效或过大。"); return }
                    var body: [String: Any] = ["message": "Sync personal reader", "branch": branch, "content": content]
                    if let sha = call.getString("sha") {
                        guard self.matches(sha, "^[a-f0-9]{40,64}$") else { call.reject("同步版本无效。"); return }
                        body["sha"] = sha
                    }
                    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                }
                self.request(req, id: UUID().uuidString) { response in
                    switch response {
                    case .success(let value):
                        let status = value["status"] as? Int ?? 0
                        if [200, 201, 404, 409, 422].contains(status) { call.resolve(value) }
                        else { call.reject("GitHub 同步失败（\(status)），请检查权限或请求额度。") }
                    case .failure(let error): call.reject(self.githubFailure(error))
                    }
                }
            }
        } catch { call.reject(error.localizedDescription) }
    }
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
