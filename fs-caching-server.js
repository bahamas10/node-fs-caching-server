#!/usr/bin/env node
/**
 * A caching HTTP server/proxy that stores data on the local filesystem
 *
 * Author: Dave Eddy <dave@daveeddy.com>
 * Date: May 05, 2015
 * License: MIT
 */

var events = require('events');
var fs = require('fs');
var http = require('http');
var https = require('https');
var path = require('path');
var url = require('url');
var util = require('util');

var accesslog = require('access-log');
var assert = require('assert-plus');
var mime = require('mime');
var mkdirp = require('mkdirp');
var uuid = require('uuid');
var Clone = require('readable-stream-clone');

/*
 * default headers to ignore when proxying request (not copied to backend
 * server).
 */
var NO_PROXY_HEADERS = ['date', 'server', 'host'];

/*
 * default methods that will be considered for caching - all others will be
 * proxied directly.
 */
var CACHE_METHODS = ['GET', 'HEAD'];

// default regex to match for caching.
var REGEX = /\.(png|jpg|jpeg|css|html|js|tar|tgz|tar\.gz)$/;

// safe hasOwnProperty
function hap(o, p) {
    return ({}).hasOwnProperty.call(o, p);
}

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
function FsCachingServer(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.host, 'opts.host');
    assert.number(opts.port, 'opts.port');
    assert.string(opts.backendUrl, 'opts.backendUrl');
    assert.string(opts.cacheDir, 'opts.cacheDir');
    assert.optionalRegexp(opts.regex, 'opts.regex');
    assert.optionalArrayOfString(opts.noProxyHeaders, 'opts.noProxyHeaders');
    assert.optionalArrayOfString(opts.cacheMethods, 'opts.cacheMethods');

    events.EventEmitter.call(self);

    self.host = opts.host;
    self.port = opts.port;
    self.backendUrl = opts.backendUrl;
    self.cacheDir = opts.cacheDir;
    self.regex = opts.regex || REGEX;
    self.noProxyHeaders = opts.noProxyHeaders || NO_PROXY_HEADERS;
    self.cacheMethods = opts.cacheMethods || CACHE_METHODS;
    self.server = null;
    self.idle = true;
    self.backendHttps = !!self.backendUrl.match(/^https:/);

    self._opts = opts;
}
util.inherits(FsCachingServer, events.EventEmitter);

/*
 * Start the server
 *
 * emits "listening" when the server starts
 */
FsCachingServer.prototype.start = function start() {
    var self = this;

    assert(!self.server, 'server already exists');
    assert(!self.inProgress, 'requests in progress');

    self._log('starting server');

    self.server = http.createServer(onRequest);
    self.server.listen(self.port, self.host, onListen);
    self.inProgress = {};
    self.idle = true;

    function onListen() {
        self._log('listening on http://%s:%d', self.host, self.port);
        self._log('proxying requests to %s', self.backendUrl);
        self._log('caching matches of %s', self.regex);
        self._log('caching to %s', self.cacheDir);

        self.emit('start');
    }

    function onRequest(req, res) {
        self._onRequest(req, res);
    }
};

/*
 * Stop the server
 *
 * emits "stop" when the server stops
 */
FsCachingServer.prototype.stop = function stop() {
    var self = this;

    assert(self.server, 'server does not exist');

    self.server.once('close', function () {
        self.idle = true;
        self.server = null;
        self.emit('stop');
    });
    self.server.close();
};

/*
 * A convience method for calling the given 'cb' when the server is idle.  The
 * callback will be invoked immediately if the server is idle, or will be
 * scheduled to run when the server becomes idle.
 */
FsCachingServer.prototype.onIdle = function onIdle(cb) {
    var self = this;

    assert.func(cb, 'cb');

    if (self.idle) {
        cb();
    } else {
        self.once('idle', cb);
    }
};

/*
 * Called internally when a new request is received
 */
FsCachingServer.prototype._onRequest = function _onRequest(req, res) {
    var self = this;

    var _id = uuid.v4();

    function log() {
        var s = util.format.apply(util, arguments);
        self._log('[%s] %s', _id, s);
    }

    accesslog(req, res, undefined, function (s) {
        self.emit('access-log', s);
        log(s);
    });

    log('INCOMING REQUEST - %s %s', req.method, req.url);

    // parse the URL and determine the filename
    var parsed = url.parse(req.url);
    var file;
    try {
        file = path.posix.normalize(decodeURIComponent(parsed.pathname));
    } catch (e) {
        log('failed to parse pathname - sending 400 to client -', e.message);
        res.statusCode = 400;
        res.end();
        return;
    }

    /*
     * Any request that isn't in the list of methods to cache, or any request
     * to a file that doesn't match the regex, gets proxied directly.
     */
    if (self.cacheMethods.indexOf(req.method) < 0 || ! self.regex.test(file)) {
        log('request will be proxied with no caching');

        var uristring = self.backendUrl + parsed.path;
        var uri = url.parse(uristring);
        uri.method = req.method;
        uri.headers = {};

        Object.keys(req.headers || {}).forEach(function (header) {
            if (NO_PROXY_HEADERS.indexOf(header) === -1) {
                uri.headers[header] = req.headers[header];
            }
        });

        uri.headers.host = uri.host;

        var oreq = self._request(uri, function (ores) {
            res.statusCode = ores.statusCode;
            Object.keys(ores.headers || {}).forEach(function (header) {
                if (NO_PROXY_HEADERS.indexOf(header) === -1)
                    res.setHeader(header, ores.headers[header]);
            });
            ores.pipe(res);
        });

        oreq.once('error', function (e) {
            res.statusCode = 500;
            res.end();
        });

        req.pipe(oreq);
        return;
    }

    // make the filename relative to the cache dir
    file = path.join(self.cacheDir, file);

    // check to see if the file exists
    fs.stat(file, function (err, stats) {
        // directory, give up
        if (stats && stats.isDirectory()) {
            log('%s is a directory - sending 400 to client', file);
            res.statusCode = 400;
            res.end();
            return;
        }

        // file exists, stream it locally
        if (stats) {
            log('%s is a file (cached) - streaming to client', file);
            streamFile(file, stats, req, res);
            return;
        }

        // another request is already proxying for this file, we wait
        if (hap(self.inProgress, file)) {
            log('%s download in progress - response queued', file);
            self.inProgress[file].push({
                id: _id,
                req: req,
                res: res,
            });
            return;
        }

        // error with stat, proxy it
        self.inProgress[file] = [];
        self.idle = false;

        var uristring = self.backendUrl + parsed.path;
        var uri = url.parse(uristring);
        uri.method = req.method;
        uri.headers = {};
        Object.keys(req.headers || {}).forEach(function (header) {
            if (NO_PROXY_HEADERS.indexOf(header) === -1)
                uri.headers[header] = req.headers[header];
        });
        uri.headers.host = uri.host;

        log('proxying %s to %s', uri.method, uristring);

        // proxy it
        var oreq = self._request(uri, function (ores) {
            res.statusCode = ores.statusCode;

            Object.keys(ores.headers || {}).forEach(function (header) {
                if (NO_PROXY_HEADERS.indexOf(header) === -1) {
                    res.setHeader(header, ores.headers[header]);
                }
            });

            if (res.statusCode < 200 || res.statusCode >= 300) {
                //ores.pipe(res);
                log('statusCode %d from backend not in 200 range - proxying ' +
                    'back to caller', res.statusCode);
                finish({
                    statusCode: res.statusCode,
                });
                res.end();
                return;
            }

            mkdirp(path.dirname(file), function (err) {
                var tmp = file + '.in-progress';

                log('saving local file to %s', tmp);

                var ws = fs.createWriteStream(tmp);

                ws.once('finish', function () {
                    fs.rename(tmp, file, function (err) {
                        if (err) {
                            log('failed to rename %s to %s', tmp, file);
                            finish({
                                statusCode: 500
                            });
                            return;
                        }

                        // everything worked! proxy all with success
                        log('renamed %s to %s', tmp, file);
                        finish({
                            ores: ores
                        });
                    });
                });

                ws.once('error', function (e) {
                    log('failed to save local file %s', e.message);
                    ores.unpipe(ws);
                    finish({
                        statusCode: 500,
                    });
                });

                var ores_ws = new Clone(ores);
                var ores_res = new Clone(ores);
                ores_ws.pipe(ws);
                ores_res.pipe(res);
            });
        });

        oreq.on('error', function (e) {
            log('error with proxy request %s', e.message);
            res.statusCode = 500;
            res.end();
            finish({
                statusCode: 500
            });
        });

        oreq.end();
    });

    /*
     * Process requests that may be blocked on the current file to be cached.
     */
    function finish(opts) {
        assert.object(opts, 'opts');
        assert.optionalNumber(opts.statusCode, 'opts.statusCode');
        assert.optionalObject(opts.ores, 'opts.ores');

        if (hap(opts, 'statusCode')) {
            self.inProgress[file].forEach(function (o) {
                o.res.statusCode = opts.statusCode;
                o.res.end();
            });

            delete self.inProgress[file];
            checkIdle();
            return;
        }

        assert.object(opts.ores, 'opts.ores');
        fs.stat(file, function (err, stats) {
            if (stats && stats.isDirectory()) {
                // directory, give up
                self.inProgress[file].forEach(function (o) {
                    o.res.statusCode = 400;
                    o.res.end();
                });
            } else if (stats) {
                // file exists, stream it locally
                self.inProgress[file].forEach(function (o) {
                    o.res.statusCode = opts.ores.statusCode;

                    Object.keys(opts.ores.headers || {}).forEach(function (header) {
                        if (NO_PROXY_HEADERS.indexOf(header) === -1) {
                            o.res.setHeader(header, opts.ores.headers[header]);
                        }
                    });

                    streamFile(file, stats, o.req, o.res);
                });
            } else {
                // not found
                self.inProgress[file].forEach(function (o) {
                    o.res.statusCode = 500;
                    o.res.end();
                });
            }

            delete self.inProgress[file];
            checkIdle();
        });
    }

    /*
     * Check if the server is idle and emit an event if it is
     */
    function checkIdle() {
        if (Object.keys(self.inProgress).length === 0) {
            self.idle = true;
            self.emit('idle');
        }
    }
};

/*
 * Emit a "log" event with the given arguments (formatted via util.format)
 */
FsCachingServer.prototype._log = function _log() {
    var self = this;

    var s = util.format.apply(util, arguments);

    self.emit('log', s);
};

/*
 * Create an outgoing http/https request based on the backend URL
 */
FsCachingServer.prototype._request = function _request(uri, cb) {
    var self = this;

    if (self.backendHttps) {
        return https.request(uri, cb);
    } else {
        return http.request(uri, cb);
    }
};

/*
 * Given a filename and its stats object (and req and res)
 * stream it to the caller.
 */
function streamFile(file, stats, req, res) {
    var etag = util.format('"%d-%d"', stats.size, stats.mtime.getTime());

    res.setHeader('Last-Modified', stats.mtime.toUTCString());
    res.setHeader('Content-Type', mime.lookup(file));
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
        // etag matched, end the request
        res.statusCode = 304;
        res.end();
        return;
    }

    res.setHeader('Content-Length', stats.size);
    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    var rs = fs.createReadStream(file);
    rs.pipe(res);
    rs.once('error', function (e) {
        res.statusCode = e.code === 'ENOENT' ? 404 : 500;
        res.end();
    });
    res.once('close', function () {
        rs.destroy();
    });
}

/*
 * Main method (invoked from CLI)
 */
function main() {
    var getopt = require('posix-getopt');

    var package = require('./package.json');

    // command line arguments
    var opts = {
        host: process.env.FS_CACHE_HOST || '0.0.0.0',
        port: process.env.FS_CACHE_PORT || 8080,
        backendUrl: process.env.FS_CACHE_URL,
        cacheDir: process.env.FS_CACHE_DIR || process.cwd(),
        regex: process.env.FS_CACHE_REGEX,
    };
    var debug = false;

    var usage = [
        'usage: fs-caching-server [options]',
        '',
        'options',
        '  -c, --cache-dir <dir>     [env FS_CACHE_DIR] directory to use for caching data, defaults to CWD',
        '  -d, --debug               enable debug logging to stderr',
        '  -H, --host <host>         [env FS_CACHE_HOST] the host on which to listen, defaults to ' + opts.host,
        '  -h, --help                print this message and exit',
        '  -p, --port <port>         [env FS_CACHE_PORT] the port on which to listen, defaults to ' + opts.port,
        '  -r, --regex <regex>       [env FS_CACHE_REGEX] regex to match to cache files, defaults to ' + opts.regex,
        '  -U, --url <url>           [env FS_CACHE_URL] URL to proxy to',
        '  -u, --updates             check npm for available updates',
        '  -v, --version             print the version number and exit',
    ].join('\n');

    var options = [
        'c:(cache-dir)',
        'd(debug)',
        'H:(host)',
        'h(help)',
        'p:(port)',
        'r:(regex)',
        'U:(url)',
        'u(updates)',
        'v(version)'
    ].join('');
    var parser = new getopt.BasicParser(options, process.argv);
    var option;
    while ((option = parser.getopt()) !== undefined) {
        switch (option.option) {
        case 'c': opts.cacheDir = option.optarg; break;
        case 'd': debug = true; break;
        case 'H': opts.host = option.optarg; break;
        case 'h': console.log(usage); process.exit(0); break;
        case 'p': opts.port = parseInt(option.optarg, 10); break;
        case 'r': opts.regex = option.optarg; break;
        case 'U': opts.backendUrl = option.optarg; break;
        case 'u': // check for updates
            require('latest').checkupdate(package, function (ret, msg) {
                console.log(msg);
                process.exit(ret);
            });
            return;
        case 'v': console.log(package.version); process.exit(0); break;
        default: console.error(usage); process.exit(1);
        }
    }

    if (!opts.backendUrl) {
        console.error('url must be specified with `-U <url>` or as FS_CACHE_URL');
        process.exit(1);
    }

    if (opts.regex) {
        opts.regex = new RegExp(opts.regex);
    }

    // remove trailing slash
    opts.backendUrl = opts.backendUrl.replace(/\/{0,}$/, '');

    var fsCachingServer = new FsCachingServer(opts);

    if (debug) {
        fsCachingServer.on('log', console.error);
    } else {
        fsCachingServer.on('access-log', console.log);
    }

    fsCachingServer.start();
}

if (require.main === module) {
    main();
} else {
    module.exports = FsCachingServer;
    module.exports.FsCachingServer = FsCachingServer;
}
