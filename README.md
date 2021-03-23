fs-caching-server
=================

A caching HTTP server/proxy that stores data on the local filesystem

Installation
------------

    [sudo] npm install [-g] fs-caching-server

`v1.0.0` Release Notes
----------------------

`v1.0.0` adds the following changes as well as bug fixes.

- Fixes HEAD before GET caching - old behavior would cache 0-byte files
- Handles redirects (or more accurately, doesn't handle - just proxies them)
- Can retrieve from an HTTPS backend URL
- Tests! there were none before - now a lot of tests have been added to ensure functionality
- Can be used as a module (this added mostly for testing)
- Cache dir can be specified as an argument/env variable - CWD not required anymore
- Access logs now contain debug UUID if debug is specified

CLI
---

### Description

The `fs-caching-server` program installed can be used to spin up an HTTP server
that acts a proxy to any other HTTP(s) server - with the added ability to
cache GET and HEAD requests that match a given regex.

### Example

This will create a caching proxy that fronts Joyent's pkgsrc servers

    $ mkdir cache
    $ fs-caching-server -c cache/ -d -U https://pkgsrc.joyent.com
    listening on http://0.0.0.0:8080
    proxying requests to https://pkgsrc.joyent.com
    caching matches of /\.(png|jpg|jpeg|css|html|js|tar|tgz|tar\.gz)$/
    caching to /home/dave/dev/fs-caching-server/cache

`-d` enables debug output which can be used to determine if a file was a cache
hit, cache miss, or skipped the cache completely.  For example, we can request
a file twice to see that it will be proxied and downloaded the first time, and
the second time it will just be streamed from the local cache.

    [58b93965-b7de-4669-9cb1-aff39e16a4fb] INCOMING REQUEST - GET /packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz
    [58b93965-b7de-4669-9cb1-aff39e16a4fb] proxying GET to http://pkgsrc.joyent.com/packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz
    [58b93965-b7de-4669-9cb1-aff39e16a4fb] saving local file to ./packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz.in-progress
    10.0.1.35 - - [16/May/2015:20:31:39 -0400] "GET /packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz HTTP/1.1" 200 12432 "-" "libfetch/2.0"
    [58b93965-b7de-4669-9cb1-aff39e16a4fb] renamed ./packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz.in-progress to ./packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz
    ...
    [ff8a1519-597f-4f9a-a999-bd05677896c2] INCOMING REQUEST - GET /packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz
    [ff8a1519-597f-4f9a-a999-bd05677896c2] ./packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz is a file (cached) - streaming to client
    10.0.1.35 - - [16/May/2015:20:32:48 -0400] "GET /packages/SmartOS/2014Q4/x86_64/All/watch-3.2.6nb1.tgz HTTP/1.1" 200 12432 "-" "curl/7.39.0"

The lines that begin with `[<uuid>]` are only printed when debug (`-d`) is
enabled - each UUID represents a unique incoming request.  The first request
shows the file was proxied to pkgsrc.joyent.com and streamed to both the client
and the local filesystem.  The second request shows the file was already
present so it was streamed to the client without ever reaching out to
pkgsrc.joyent.com.

### Usage

    $ fs-caching-server -h
    usage: fs-caching-server [options]

    options
      -c, --cache-dir <dir>     [env FS_CACHE_DIR] directory to use for caching data, defaults to CWD
      -d, --debug               enable debug logging to stderr
      -H, --host <host>         [env FS_CACHE_HOST] the host on which to listen, defaults to 0.0.0.0
      -h, --help                print this message and exit
      -p, --port <port>         [env FS_CACHE_PORT] the port on which to listen, defaults to 8080
      -r, --regex <regex>       [env FS_CACHE_REGEX] regex to match to cache files, defaults to undefined
      -U, --url <url>           [env FS_CACHE_URL] URL to proxy to
      -u, --updates             check npm for available updates
      -v, --version             print the version number and exit

Module
------

### Description

This module can also be used as a JavaScript module.

### Example

``` js
var FsCachingServer = require('fs-caching-server').FsCachingServer;

// proxy to Joyent's pkgsrc
var opts = {
    cacheDir: '/home/dave/cache-dir',
    host: '0.0.0.0',
    port: 8080,
    backendUrl: 'https://pkgsrc.joyent.com'
};

var cachingServer = new FsCachingServer(opts);

cachingServer.once('start', function () {
    console.log('server started');
});

if (process.env.NODE_DEBUG) {
    // debug messages go to stderr
    cachingServer.on('log', console.error);
}

// access log messages to stdout
cachingServer.on('access-log', console.log);

cachingServer.start();
```

### Usage

``` js
/*
 * FsCachingServer
 *
 * Create an instance of an FS Caching Server
 *
 * Aurguments
 *  opts                  Object
 *    opts.host           String (Required) Host to bind to. ex: '0.0.0.0',
 *                                          '127.0.0.1', etc.
 *    opts.port           Number (Required) Port to bind to. ex: 80, 8080, etc.
 *    opts.backendUrl     String (Required) URL of the backend to proxy
 *                                          requests to. ex:
 *                                          'http://1.2.3.4:5678'
 *    opts.cacheDir       String (Required) Directory for the cached items. ex:
 *                                          '/tmp/fs-caching-server'
 *    opts.regex          RegExp (Optional) Regex to match to enable caching,
 *                                          defaults to REGEX above.
 *    opts.noProxyHeaders Array  (Optional) An array of headers to not proxy to
 *                                          the backend, default is [date,
 *                                          server, host].
 *    opts.cacheMethods   Array  (Optional) An array of methods to proxy,
 *                                          default is [GET, HEAD].
 *
 * Methods
 *
 * .start()
 *  - Start the server.
 *
 * .stop()
 *  - Stop the server.
 *
 * .onIdle(cb)
 *  - Call the callback when the caching server is "idle" (see events below).
 *
 * Events
 *
 * 'start'
 *  - Called when the listener is started.
 *
 * 'stop'
 *  - Called when the listener is stopped.
 *
 * 'access-log'
 *  - Called per-request with a CLF-formatted apache log style string.
 *
 * 'log'
 *  - Called with debug logs from the server - useful for debugging.
 *
 * 'idle'
 *  - Called when the server is idle.  "idle" does not mean there are not
 *  pending web requests, but instead means there are no pending filesystem
 *  actions remaining.  This is useful for writing automated tests.
 */
 ```

Testing
-------

```
$ NODE_DEBUG=1 npm test


> fs-caching-server@0.0.3 test /home/dave/dev/node-fs-caching-server
> ./node_modules/tape/bin/tape tests/*.js

TAP version 13
# start cachingServer
ok 1 tmp dir "/home/dave/dev/node-fs-caching-server/tests/tmp" cleared
starting server
listening on http://127.0.0.1:8081
proxying requests to http://127.0.0.1:8080
caching matches of /\.(png|jpg|jpeg|css|html|js|tar|tgz|tar\.gz)$/
caching to /home/dave/dev/node-fs-caching-server/tests/tmp
ok 2 cachingServer started
# start backendServer
ok 3 backendServer started on http://127.0.0.1:8080
# simple cached request
[63e44996-ac28-4a0f-b306-61aeeb88b53c] INCOMING REQUEST - GET /hello.png
[63e44996-ac28-4a0f-b306-61aeeb88b53c] proxying GET to http://127.0.0.1:8080/hello.png
[63e44996-ac28-4a0f-b306-61aeeb88b53c] saving local file to /home/dave/dev/node-fs-caching-server/tests/tmp/hello.png.in-progress
[63e44996-ac28-4a0f-b306-61aeeb88b53c] 127.0.0.1 - - [13/Mar/2021:20:58:52 -0500] "GET /hello.png HTTP/1.1" 200 48 "-" "-"
...
...
...
ok 50 backendServer closed
# stop cachingServer
ok 51 cachingServer stopped

1..51
# tests 51
# pass  51

# ok
```

License
-------

MIT License
