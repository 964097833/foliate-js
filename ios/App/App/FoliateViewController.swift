import Capacitor

final class FoliateViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FoliateNativePlugin())
    }
}
