# 🧣 scarf ~ *stream chunks as rpc frames* 

```
npm install @yipyap/scarf --save
```

## what

scarf is a subset of the [JSON-RPC 2.0](http://www.jsonrpc.org/specification) 
specification with one restriction, which is that `params` and `result` must 
be *positional* (`[]`), not named. In addition, it introduces a mechanism for 
describing streams.

When a result of an RPC contains a `scarf://` URL, the client should expose a 
readable or writable stream interface, where reading from this pointer is 
performed by listening for or sending JSON-RPC "notification" payloads 
where the method name matches the original string value and the `params` 
array represents items to be read from or written to the virtual stream.

This allows servers implementing scarf to pass streams back to clients as 
result parameters. Individual JSON-RPC payloads are separated by `\r\n` (a 
carriage return followed by a newline) over a bidirectional stream. This 
package implements the protocol over TCP or Unix Domain Sockets, but any transport
can be used by overloading `new scarf.Server(api = Object, createServer = Function)`.

## why

This package and protocol was written for use in [🝰 dusk](https://rundusk.org). It is
used as the transport and protocol for controlling the daemon from the CLI and other 
applications. In general, it is inspired by Tor's control protocol. 

It is a revival of my defunct package [boscar](https://www.npmjs.com/package/boscar), 
originally written for similar purposes for use in early versions of 
[Storj](https://storj.io). 

In both instances, the need to be able to have inter-process communication for sending
control commands as well as streaming data in and out is why this package exists. Instead
of having two connection channels (one for control and one for data, like FTP), scarf 
allows you to embed streams within the control protocol, allowing for context-awareness 
at the protocol level instead of application level.

## how

### example: server

```js
const { Readable } = require('stream');
const { Server } = require('@yipyap/scarf');

const server = new Server({
  echo: function(data, callback) {
    const buffer = Buffer.from(data);
    callback(null, Readable.from(buffer));
  }
});

server.listen(8080);
```

### example: client

```js
const scarf = require('@yipyap/scarf');
const client = new scarf.Client();

client.connect(8080);
client.invoke('echo', ['hello world'], (err, stream) => {
  stream.pipe(process.stdout); // => 'hello world'
});
```

## license

anti-copyright 2025, chihuahua.rodeo  
released under gnu lesser general public license 3
