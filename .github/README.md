# 👻 GhostPad for iPad

The iPad / iPhone side of **GhostPad**: join a friend's PC game as Player 2 from anywhere.
Type the code shown on your friend's PC, and their screen and sound stream to you while your
touches (or a Bluetooth controller) act as an Xbox controller on their PC.

## Get it
- **Web app (no install):** open the GitHub Pages link of this repository in Safari, then
  **Share → Add to Home Screen**.
- **.ipa:** open the latest run under **Actions → Build iPad app**, download **GhostPad-ipa**, and
  install it with Sideloadly or AltStore (it's unsigned; they sign it with your Apple ID).

## Build it yourself
`ipad/www` is the app; `ipad/ios` wraps it with XcodeGen
(`brew install xcodegen && cd ipad/ios && xcodegen generate`, then open `GhostPad.xcodeproj`).
