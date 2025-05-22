'use strict';

const { Stream, Transform, Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { randomUUID: uuid } = require('node:crypto');
const net = require('node:net');
const jsonrpc = require('jsonrpc-lite');
const { URL } = require('node:url');

/**
 * @private
 */
class Serializer extends Transform {

  constructor() {
    super({ objectMode: true });
  }

  _transform(data, encoding, callback) {
    callback(null, JSON.stringify(data) + '\r\n');
  }

}

/**
 * @private
 */
class Deserializer extends Transform {

  constructor() {
    super({ objectMode: true });
    this._buffer = '';
  }

  _transform(data, encoding, callback) {
    this._buffer += data.toString();

    if (this._buffer.indexOf('\r\n') === -1) {
      return callback();
    }

    let valid = true;
    let parts = this._buffer.split('\r\n');

    while (valid && parts.length) {
      let rpc = jsonrpc.parse(parts[0]);

      if (rpc.type !== 'invalid') {
        this.push(rpc);
        parts.shift();
      } else {
        valid = false;
      }
    }

    this._buffer = parts.join('\r\n');
    callback();
  }

}

function _createStreamPointer(ctx, stream, serializer) {
  let id = uuid();
  let readable = typeof stream.read === 'function';
  let type = readable ? 'readable' : 'writable';
  let pointer = `mascara://${id}.${type}`;

  ctx.streams.set(pointer, stream);

  if (readable) {
    _bindReadable(pointer, stream, serializer);
  }

  return pointer;
}

function _bindReadable(pointer, stream, serializer) {
  stream.on('data', (data) => {
    serializer.write(jsonrpc.notification(pointer, [data]));
  });
  stream.on('end', () => {
    serializer.write(jsonrpc.notification(pointer, [null]));
  });
  stream.on('error', () => {
    serializer.write(jsonrpc.notification(pointer, [null]));
  });
}

class Server extends EventEmitter {

  /**
   * @typedef {Function} Server~RpcHandler
   * @param {...(number|string|boolean|object|array|Stream)} argument - Implementation specific arguments
   * @param {Server~rpcHandlerCallback} callback - Completion callback that must be called
   */

  /**
   * @callback Server~rpcHandlerCallback
   * @param {?Error} [err] - Error object if the handler fails
   * @param {Array.<(string|boolean|number|object|array|Stream)>} [result] - Success result if any
   */

  /**
   * @typedef {Function} Server~createServer
   * @param {Server~connectionHandlerCallback} callback - Client connection callback
   * @returns {Server~AbstractServer}
   */

  /**
   * @callback Server~connectionHandlerCallback
   * @param {stream.Duplex} clientConnection - Stream that represents a connected client
   */

  /**
   * @typedef {stream.Duplex} Server~AbstractServer
   * @property {Function} listen - Returned server must also implement this
   */

  /**
   * Implementation of a mascara server. Takes an API definition
   * and routes JSON-RPC messages to their handlers, automatically
   * transforming mascara:// links into streams.
   * @extends EventEmitter
   * @constructor
   * @param {Object.<string, Server~RpcHandler>} api - Map of methods to message handler functions
   * @param {?Server~createServer} [createServer=net.createServer] - Function returning a duplex stream
   */
  constructor(api = {}, createServer) {
    super();

    this.api = api;
    this.clients = new Map();
    this.server = createServer
      ? createServer(stream => this._registerClient(stream))
      : net.createServer(stream => this._registerClient(stream));
    this.streams = new Map();
  }

  /**
   * Passthrough function that calls the underlying {@link Server~AbstractServer}'s listen() method 
   */
  listen() {
    this.server.listen(...arguments);
  }

  _registerClient(stream) {
    const id = uuid();
    const serializer = new Serializer();
    const deserializer = new Deserializer();

    this.clients.set(id, { stream, serializer, deserializer });

    stream.on('error', () => this.clients.delete(id));
    stream.on('close', () => this.clients.delete(id));
    stream.pipe(deserializer).on('data', rpc => this._execMethod(rpc, id));
    serializer.pipe(stream);
  }

  _execMethod(rpc, client) {
    const { serializer } = this.clients.get(client);
    const { type, payload } = rpc;

    if (type === 'notification') {
      let parsedUrl;

      try {
        parsedUrl = new URL(payload.method);
      } catch (e) {
        return serializer.write(
          jsonrpc.error(payload.id, new jsonrpc.JsonRpcError(
            `Invalid stream reference: "${payload.method}"`
          ))
        );
      }
      
      let stream = this.streams.get(payload.method);

      if (stream) {
        return payload.params.forEach((data) => {
          if (data === null) {
            stream.end();
          } else {
            stream.write(data);
          }
        });
      }

      this.emit('unhandled', rpc);
    }

    if (typeof this.api[payload.method] !== 'function') {
      return serializer.write(
        jsonrpc.error(payload.id, new jsonrpc.JsonRpcError(
          `Invalid method: "${payload.method}"`
        ))
      );
    }

    const srv = this;

    function handleResultCallback(err) {
      if (err) {
        return serializer.write(
          jsonrpc.error(payload.id, new jsonrpc.JsonRpcError(err.message))
        );
      }

      const args = [...arguments];

      for (let a = 0; a < args.length; a++) {
        if (args[a] instanceof Stream) {
          args[a] = _createStreamPointer(srv, args[a], serializer);
        }
      }

      serializer.write(jsonrpc.success(payload.id, args.slice(1)));
    }

    try {
      this.api[payload.method](...payload.params, handleResultCallback);
    } catch (err) {
      serializer.write(
        jsonrpc.error(payload.id, new jsonrpc.JsonRpcError(err.message))
      );
    }
  }

}

class Client extends EventEmitter {

  /**
   * @typedef {Function} Client~createClient
   * @returns {Client~AbstractClient}
   */

  /**
   * @typedef {stream.Duplex} Client~AbstractClient
   * @property {Function} connect - Returned client must also implement this
   */

  /**
   * Implementation of a mascara client. Connects to a mascara {@link Server} and 
   * automatically transforms stream arguments into mascara:// links and vice-versa.
   * @extends EventEmitter
   * @constructor
   * @param {Client~createClient} [createClient=new net.Socket()] - Function returning a Duplex stream
   */
  constructor(createClient) {
    super();

    this.stream = createClient
      ? createClient()
      : new net.Socket();
    this.deserializer = new Deserializer();
    this.serializer = new Serializer();
    this._callbacks = new Map();
    this.streams = new Map();

    this.stream.pipe(this.deserializer);
    this.serializer.pipe(this.stream);
    this.stream.on('error', (err) => this.emit('error', err));
    this.deserializer.on('data', (rpc) => this._process(rpc));
  }

  /**
   * Passthrough function that calls the underlying {@link Client~AbstractClient}'s connect() method 
   */
  connect() {
    this.stream.connect(...arguments);
  }

  _process(rpc) {
    const { type, payload } = rpc;

    const handleResponse = () => {
      let callback = this._callbacks.get(payload.id);
      let { result } = payload;

      if (result) {
        for (let p = 0; p < result.length; p++) {
          if (typeof result[p] === 'string' && result[p].includes('mascara://')) {
            const parsedUrl = new URL(result[p]);
            let [id, streamType] = parsedUrl.hostname.split('.');
            let pointer = `mascara://${id}.${streamType}`;
            let stream = null;

            if (streamType === 'writable') {
              stream = result[p] = new Transform({
                write: (data, encoding, callback) => {
                  this.serializer.write(
                    jsonrpc.notification(pointer, [data])
                  );
                  callback();
                },
                flush: (callback) => {
                  this.serializer.write(
                    jsonrpc.notification(pointer, [null])
                  );
                  callback();
                },
                objectMode: true
              });

              stream.on('finish', () => this.streams.delete(id));
            } else {
              stream = result[p] = new Readable({
                read: () => null,
                objectMode: true
              });

              stream.on('end', () => this.streams.delete(id));
            }
            this.streams.set(pointer, stream);
          }
        }
        
        callback(null, ...payload.result);
      } else {
        callback(new Error(payload.error.message));
      }

      this._callbacks.delete(payload.id);
    };

    const handleNotification = () => {
      let parsedUrl;

      try {
        parsedUrl = new URL(payload.method);
      } catch (e) {
        return this.emit('unhandled', rpc);
      }

      let stream = this.streams.get(payload.method);

      if (!stream) {
        return this.emit('unhandled', rpc);
      }

      payload.params.forEach((param) => stream.push(param));
    };

    if (['success', 'error'].includes(type)) {
      handleResponse();
    } else if (type === 'notification') {
      handleNotification();
    } else {
      this.emit('unhandled', rpc);
    }
  }

  _invoke(method, params) {
    return new Promise((resolve, reject) => {
      const id = uuid();
      
      this._callbacks.set(id, function(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });

      this.serializer.write(jsonrpc.request(id, method, params));
    });
  }

  /**
   * @callback Client~invokeCallback
   * @param {?Error} [err] - Error object if the request fails
   * @param {Array.<(string|boolean|number|object|array|Stream)>} [result] - Success result if any
   */

  /**
   * Constructs a mascara message from the given arguents and handles the response
   * @param {string} method - JSON-RPC method name
   * @param {Array.<(string|array|boolean|object|number|Stream)>} params - Data to send the server
   * @param {Client~invokeCallback} [callback] - Handle the results returned from the server
   * @returns {Promise}
   */
  invoke(method, params, callback) {
    if (typeof callback === 'function') {
      return this._invoke(method, params).then(function(result) {
        callback(null, result);
      }, callback);
    } else {
      return this._invoke(method, params);
    }
  }
}


module.exports.Server = Server;
module.exports.Client = Client;
