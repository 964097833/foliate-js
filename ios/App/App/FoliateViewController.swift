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
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FoliateNativePlugin())
    }
}
