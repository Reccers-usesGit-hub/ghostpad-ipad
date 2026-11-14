# 👻 GhostPad for iPad

The iPad / iPhone side of **GhostPad**: join a friend's PC game as Player 2 from anywhere.
Type the code shown on your friend's PC, and their screen and sound stream to you while your
touches (or a Bluetooth controller) act as an Xbox controller on their PC.

## Get it
Open **https://reccers-usesgit-hub.github.io/ghostpad-ipad/** in **Safari**, then
**Share → Add to Home Screen**, and always start GhostPad from that home-screen icon.
Nothing to install, and it updates by itself.

## How it's built
`ipad/www` is the whole app (plain HTML/CSS/JS + PeerJS). Every push to `ipad/www` republishes it on
GitHub Pages (`.github/workflows/build-ipad.yml`).
