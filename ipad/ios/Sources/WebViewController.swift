import UIKit
import WebKit
import GameController

/// Hosts the GhostPad web app (bundled in www/) full-screen, and bridges what a
/// web page can't do well on iOS: saving data, keeping the screen awake, and
/// Bluetooth game controllers.
final class WebViewController: UIViewController, WKScriptMessageHandler, WKUIDelegate {
    private var webView: WKWebView!
    private var pendingPadJS: String?
    private var padFlushScheduled = false

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let content = WKUserContentController()
        content.add(WeakMessageHandler(self), name: "ghost")
        content.addUserScript(WKUserScript(source: Self.bootstrapScript(),
                                           injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true))
        config.userContentController = content

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.uiDelegate = self
        if #available(iOS 16.4, *) { web.isInspectable = true }
        webView = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
        setUpControllers()
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    // MARK: saved data

    /// Hands the web app its saved data (device id, saved PCs, settings) before it starts.
    private static func bootstrapScript() -> String {
        var store = "null"
        if let json = UserDefaults.standard.string(forKey: "ghostStore"),
           let data = json.data(using: .utf8),
           (try? JSONSerialization.jsonObject(with: data)) != nil {
            store = json
        }
        return "window.__ghostNative = { platform: 'ios-app', store: \(store) };"
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "store":
            if let json = body["json"] as? String { UserDefaults.standard.set(json, forKey: "ghostStore") }
        case "awake":
            UIApplication.shared.isIdleTimerDisabled = (body["on"] as? Bool) ?? false
        default:
            break
        }
    }

    // MARK: JavaScript alert()/confirm()

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // MARK: Bluetooth controllers (Xbox, PlayStation, MFi...)

    private func setUpControllers() {
        NotificationCenter.default.addObserver(self, selector: #selector(controllerDidConnect(_:)),
                                               name: .GCControllerDidConnect, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(controllerDidDisconnect(_:)),
                                               name: .GCControllerDidDisconnect, object: nil)
        GCController.controllers().forEach(attach)
    }

    @objc private func controllerDidConnect(_ note: Notification) {
        if let controller = note.object as? GCController { attach(controller) }
    }

    @objc private func controllerDidDisconnect(_ note: Notification) {
        let anyLeft = GCController.controllers().contains { $0.extendedGamepad != nil }
        if !anyLeft { webView.evaluateJavaScript("window.__gpNativePadGone && __gpNativePadGone()", completionHandler: nil) }
    }

    private func attach(_ controller: GCController) {
        guard let pad = controller.extendedGamepad else { return }
        pad.valueChangedHandler = { [weak self] gamepad, _ in self?.forward(gamepad) }
        forward(pad)
    }

    /// Sends the controller state to the web app using the Xbox (XInput) button bits.
    private func forward(_ g: GCExtendedGamepad) {
        var b = 0
        if g.dpad.up.isPressed { b |= 0x0001 }
        if g.dpad.down.isPressed { b |= 0x0002 }
        if g.dpad.left.isPressed { b |= 0x0004 }
        if g.dpad.right.isPressed { b |= 0x0008 }
        if g.buttonMenu.isPressed { b |= 0x0010 }
        if g.buttonOptions?.isPressed == true { b |= 0x0020 }
        if g.leftThumbstickButton?.isPressed == true { b |= 0x0040 }
        if g.rightThumbstickButton?.isPressed == true { b |= 0x0080 }
        if g.leftShoulder.isPressed { b |= 0x0100 }
        if g.rightShoulder.isPressed { b |= 0x0200 }
        if g.buttonHome?.isPressed == true { b |= 0x0400 }
        if g.buttonA.isPressed { b |= 0x1000 }
        if g.buttonB.isPressed { b |= 0x2000 }
        if g.buttonX.isPressed { b |= 0x4000 }
        if g.buttonY.isPressed { b |= 0x8000 }

        func axis(_ v: Float) -> Int { Int((max(-1, min(1, v)) * 32767).rounded()) }
        func trigger(_ v: Float) -> Int { Int((max(0, min(1, v)) * 255).rounded()) }

        pendingPadJS = "window.__gpNativePad&&__gpNativePad(\(b),"
            + "\(axis(g.leftThumbstick.xAxis.value)),\(axis(g.leftThumbstick.yAxis.value)),"
            + "\(axis(g.rightThumbstick.xAxis.value)),\(axis(g.rightThumbstick.yAxis.value)),"
            + "\(trigger(g.leftTrigger.value)),\(trigger(g.rightTrigger.value)))"

        // Coalesce bursts of changes into one call per run-loop pass.
        guard !padFlushScheduled else { return }
        padFlushScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.padFlushScheduled = false
            if let js = self.pendingPadJS {
                self.pendingPadJS = nil
                self.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
}

/// Avoids a retain cycle between WKUserContentController and the view controller.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
