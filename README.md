fs-caching-server
=================

A caching HTTP server/proxy that stores data on the local filesystem

Installation
------------

    [sudo] npm install -g fs-caching-server

Description
-----------

The `fs-caching-server` program installed can be used to spin up an HTTP server
that acts a proxy to any other HTTP(s) server - with the added ability to
cache GET and HEAD requests that match a given regex.

Example
-------

This will create a caching proxy that fronts Joyent's pkgsrc servers

    $ mkdir cache
    $ fs-caching-server -c cache/ -d -U http://pkgsrc.joyent.com
    listening on http://0.0.0.0:8080
    proxying requests to http://pkgsrc.joyent.com
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

Usage
-----

    $ fs-caching-server -h
    usage: fs-caching-server [options]

    options
      -c, --cache-dir <dir>     directory to use for caching data, defaults to CWD
      -d, --debug               enable debug logging to stderr
      -H, --host <host>         [env FS_CACHE_HOST] the host on which to listen, defaults to 0.0.0.0
      -h, --help                print this message and exit
      -p, --port <port>         [env FS_CACHE_PORT] print this message and exit
      -r, --regex <regex>       [env FS_CACHE_REGEX] regex to match to cache files, defaults to \.(png|jpg|jpeg|css|html|js|tar|tgz|tar\.gz)$
      -U, --url <url>           [env FS_CACHE_URL] URL to proxy to, defaults to undefined
      -u, --updates             check npm for available updates
      -v, --version             print the version number and exit

License
-------

MIT License
