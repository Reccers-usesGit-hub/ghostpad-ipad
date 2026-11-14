// GhostPad connection routes — shared by the iPad app and the PC app.
// STUN finds each device's public address so they can connect directly (works on most home
// networks). A relay (TURN) server carries the traffic when a direct route is impossible
// (strict routers, mobile hotspots, some school/work Wi-Fi). Free STUN needs no account; a relay
// needs one (e.g. Cloudflare Realtime or Metered) — PeerJS's own free relays were shut down.
'use strict';

(function () {
  const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

  // relay = { urls: "turn:host:3478, turns:host:443?transport=tcp", username, credential }
  function iceServers(relay) {
    const list = [{ urls: STUN }];
    const urls = String((relay && relay.urls) || '').split(/[\s,]+/).filter((u) => /^turns?:/i.test(u));
    if (urls.length) list.push({ urls, username: String(relay.username || ''), credential: String(relay.credential || '') });
    return list;
  }

  // Gathers routes the way a real call does and reports which kinds worked.
  async function testRoutes(relay) {
    const pc = new RTCPeerConnection({ iceServers: iceServers(relay) });
    const types = new Set();
    pc.onicecandidate = (e) => {
      const m = e.candidate && / typ (host|srflx|prflx|relay)/.exec(e.candidate.candidate);
      if (m) types.add(m[1]);
    };
    pc.createDataChannel('test');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
    });
    pc.close();
    const relaySet = iceServers(relay).length > 1;
    return {
      direct: types.has('srflx') || types.has('prflx'),
      relaySet,
      relay: types.has('relay'),
      text: (types.has('srflx') || types.has('prflx') ? '✔ internet route found (direct connections should work)' : '✖ no internet route — check the internet connection')
        + '\n' + (relaySet ? (types.has('relay') ? '✔ relay works (backup route for strict networks)' : '✖ relay not working — check its address, username and password')
          : '– no relay set (only needed if a friend can\'t connect)'),
    };
  }

  window.GhostNet = { iceServers, testRoutes };
})();
