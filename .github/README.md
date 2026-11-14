# 👻 GhostPad for iPad

The iPad / iPhone side of **GhostPad**: join a friend's PC game as Player 2 from anywhere.
Type the code shown on your friend's PC, and their screen and sound stream to you while your
touches (or a Bluetooth controller) act as an Xbox controller on their PC.

## Get it
- **Web app (no install):** open **https://reccers-usesgit-hub.github.io/ghostpad-ipad/** in Safari, then
  **Share → Add to Home Screen**.
- **.ipa:** **[download GhostPad.ipa](https://github.com/Reccers-usesGit-hub/ghostpad-ipad/releases/latest/download/GhostPad.ipa)**
  (no GitHub account needed) and install it with Sideloadly or AltStore — it's unsigned; they sign it
  with your Apple ID. Install steps are on the [release page](https://github.com/Reccers-usesGit-hub/ghostpad-ipad/releases/latest).

## Build it yourself
`ipad/www` is the app; `ipad/ios` wraps it with XcodeGen
(`brew install xcodegen && cd ipad/ios && xcodegen generate`, then open `GhostPad.xcodeproj`).
