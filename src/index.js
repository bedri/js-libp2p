'use strict'

const Swarm = require('libp2p-swarm')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const mafmt = require('mafmt')
const PeerBook = require('peer-book')
const multiaddr = require('multiaddr')
const EventEmitter = require('events').EventEmitter
const assert = require('assert')
const Ping = require('libp2p-ping')
const setImmediate = require('async/setImmediate')

exports = module.exports

const OFFLINE_ERROR_MESSAGE = 'The libp2p node is not started yet'

class Node extends EventEmitter {
  constructor (_modules, _peerInfo, _peerBook, _options) {
    super()
    assert(_modules, 'requires modules to equip libp2p with features')
    assert(_peerInfo, 'requires a PeerInfo instance')

    this.modules = _modules
    this.peerInfo = _peerInfo
    this.peerBook = _peerBook || new PeerBook()
    this.isOnline = false

    this.swarm = new Swarm(this.peerInfo)

    // Attach stream multiplexers
    if (this.modules.connection.muxer) {
      let muxers = this.modules.connection.muxer
      muxers = Array.isArray(muxers) ? muxers : [muxers]
      muxers.forEach((muxer) => {
        this.swarm.connection.addStreamMuxer(muxer)
      })

      // If muxer exists, we can use Identify
      this.swarm.connection.reuse()

      // Received incommind dial and muxer upgrade happened,
      // reuse this muxed connection
      this.swarm.on('peer-mux-established', (peerInfo) => {
        this.emit('peer:connect', peerInfo)
        this.peerBook.put(peerInfo)
      })

      this.swarm.on('peer-mux-closed', (peerInfo) => {
        this.emit('peer:disconnect', peerInfo)
        // TODO remove this line
        this.peerBook.removeByB58String(peerInfo.id.toB58String())
      })
    }

    // Attach crypto channels
    if (this.modules.connection.crypto) {
      let cryptos = this.modules.connection.crypto
      cryptos = Array.isArray(cryptos) ? cryptos : [cryptos]
      cryptos.forEach((crypto) => {
        this.swarm.connection.crypto(crypto.tag, crypto.encrypt)
      })
    }

    // Attach discovery mechanisms
    if (this.modules.discovery) {
      let discoveries = this.modules.discovery
      discoveries = Array.isArray(discoveries) ? discoveries : [discoveries]

      discoveries.forEach((discovery) => {
        discovery.on('peer', (peerInfo) => this.emit('peer:discovery', peerInfo))
      })
    }

    // Mount default protocols
    Ping.mount(this.swarm)

    // Not fully implemented in js-libp2p yet
    this.routing = undefined
    this.records = undefined
  }

  /*
   * Start the libp2p node
   *   - create listeners on the multiaddrs the Peer wants to listen
   */
  start (callback) {
    if (!this.modules.transport) {
      return callback(new Error('no transports were present'))
    }

    let ws
    let transports = this.modules.transport

    transports = Array.isArray(transports) ? transports : [transports]
    const multiaddrs = this.peerInfo.multiaddrs

    transports.forEach((transport) => {
      if (transport.filter(multiaddrs).length > 0) {
        this.swarm.transport.add(
          transport.tag || transport.constructor.name, transport)
      } else if (transport.constructor &&
                 transport.constructor.name === 'WebSockets') {
        // TODO find a cleaner way to signal that a transport is always
        // used for dialing, even if no listener
        ws = transport
      }
    })

    // so that we can have webrtc-star addrs without adding manually the id
    this.peerInfo.multiaddrs = this.peerInfo.multiaddrs.map((ma) => {
      if (!mafmt.IPFS.matches(ma)) {
        ma = ma.encapsulate('/ipfs/' + this.peerInfo.id.toB58String())
      }
    })

    this.swarm.listen((err) => {
      if (err) {
        return callback(err)
      }
      if (ws) {
        this.swarm.transport.add(ws.tag || ws.constructor.name, ws)
      }

      this.isOnline = true

      if (this.modules.discovery) {
        this.modules.discovery.forEach((discovery) => {
          setImmediate(() => discovery.start(() => {}))
        })
      }

      callback()
    })
  }

  /*
   * Stop the libp2p node by closing its listeners and open connections
   */
  stop (callback) {
    this.isOnline = false

    if (this.modules.discovery) {
      this.modules.discovery.forEach((discovery) => {
        setImmediate(() => discovery.stop(() => {}))
      })
    }

    this.swarm.close(callback)
  }

  isOn () {
    return this.isOnline
  }

  ping (peer, callback) {
    assert(this.isOn(), OFFLINE_ERROR_MESSAGE)
    const peerInfo = this._getPeerInfo(peer)
    callback(null, new Ping(this.swarm, peerInfo))
  }

  dial (peer, protocol, callback) {
    assert(this.isOn(), OFFLINE_ERROR_MESSAGE)
    const peerInfo = this._getPeerInfo(peer)

    if (typeof protocol === 'function') {
      callback = protocol
      protocol = undefined
    }

    this.swarm.dial(peerInfo, protocol, (err, conn) => {
      if (err) {
        return callback(err)
      }
      this.peerBook.put(peerInfo)
      callback(null, conn)
    })
  }

  hangUp (peer, callback) {
    assert(this.isOn(), OFFLINE_ERROR_MESSAGE)
    const peerInfo = this._getPeerInfo(peer)

    this.peerBook.removeByB58String(peerInfo.id.toB58String())
    this.swarm.hangUp(peerInfo, callback)
  }

  handle (protocol, handlerFunc, matchFunc) {
    this.swarm.handle(protocol, handlerFunc, matchFunc)
  }

  unhandle (protocol) {
    this.swarm.unhandle(protocol)
  }

  /*
   * Helper method to check the data type of peer and convert it to PeerInfo
   */
  _getPeerInfo (peer) {
    let p
    if (PeerInfo.isPeerInfo(peer)) {
      p = peer
    } else if (multiaddr.isMultiaddr(peer)) {
      const peerIdB58Str = peer.getPeerId()
      try {
        p = this.peerBook.getByB58String(peerIdB58Str)
      } catch (err) {
        p = new PeerInfo(PeerId.createFromB58String(peerIdB58Str))
      }
      p.multiaddr.add(peer)
    } else if (PeerId.isPeerId(peer)) {
      const peerIdB58Str = peer.toB58String()
      try {
        p = this.peerBook.getByB58String(peerIdB58Str)
      } catch (err) {
        // TODO this is where PeerRouting comes into place
        throw new Error('No knowledge about: ' + peerIdB58Str)
      }
    } else {
      throw new Error('peer type not recognized')
    }

    return p
  }
}

module.exports = Node
