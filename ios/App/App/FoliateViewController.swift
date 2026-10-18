import Capacitor
import UIKit

final class FoliateViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let webView else { return }
        // Keep the entire reader viewport inside the device's safe area. WebKit's
        // automatic scroll insets do not reliably place absolute toolbars there.
        let container = UIView()
        container.backgroundColor = .systemBackground
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        let safeArea = container.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: safeArea.topAnchor),
            webView.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
        ])
        view = container
        setReadingTheme("paper")
    }

    func setReadingTheme(_ theme: String) {
        let color: UIColor
        switch theme {
        case "dark": color = UIColor(red: 32/255, green: 33/255, blue: 36/255, alpha: 1)
        case "light": color = .white
        default: color = UIColor(red: 250/255, green: 248/255, blue: 243/255, alpha: 1)
        }
        overrideUserInterfaceStyle = theme == "dark" ? .dark : .light
        view.backgroundColor = color
        webView?.isOpaque = false
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
        setNeedsStatusBarAppearanceUpdate()
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FoliateNativePlugin())
    }
}
