#!/usr/bin/env node
/**
 * A caching HTTP server/proxy that stores data on the local filesystem
 *
 * Author: Dave Eddy <dave@daveeddy.com>
 * Date: May 05, 2015
 * License: MIT
 */

var fs = require('fs');
var http = require('http');
var url = require('url');
var util = require('util');

var accesslog = require('access-log');
var getopt = require('posix-getopt');
var mime = require('mime');
var mkdirp = require('mkdirp');
var path = require('path-platform');
var uuid = require('node-uuid');
var clone = require("readable-stream-clone");

var package = require('./package.json');

function hap(o, p) {
  return ({}).hasOwnProperty.call(o, p);
}

// don't copy these headers when proxying request
var NO_PROXY_HEADERS = ['date', 'server', 'host'];

// these methods use the cache, everything is proxied
var CACHE_METHODS = ['GET', 'HEAD'];

// command line arguments
var opts = {
  host: process.env.FS_CACHE_HOST || '0.0.0.0',
  port: process.env.FS_CACHE_PORT || 8080,
  url: process.env.FS_CACHE_URL,
  regex: process.env.FS_CACHE_REGEX || '\\.(png|jpg|jpeg|css|html|js|tar|tgz|tar\\.gz)$',
  debug: process.env.FS_CACHE_DEBUG,
};

var usage = [
  'usage: fs-caching-server [options]',
  '',
  'options',
  '  -c, --cache-dir <dir>     directory to use for caching data, defaults to CWD',
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
    case 'c': process.chdir(option.optarg); break;
    case 'd': opts.debug = true; break;
    case 'H': opts.host = option.optarg; break;
    case 'h': console.log(usage); process.exit(0); break;
    case 'p': opts.port = parseInt(option.optarg, 10); break;
    case 'r': opts.regex = option.optarg; break;
    case 'U': opts.url = option.optarg; break;
    case 'u': // check for updates
      require('latest').checkupdate(package, function(ret, msg) {
        console.log(msg);
        process.exit(ret);
      });
      return;
    case 'v': console.log(package.version); process.exit(0); break;
    default: console.error(usage); process.exit(1);
  }
}

if (!opts.url) {
  console.error('url must be specified with `-U <url>` or as FS_CACHE_URL');
  process.exit(1);
}


// remove trailing slash
opts.url = opts.url.replace(/\/*$/, '');

// create the regex option - this may throw
opts.regex = new RegExp(opts.regex);

// start the server
http.createServer(onrequest).listen(opts.port, opts.host, listening);

function listening() {
  console.log('listening on http://%s:%d', opts.host, opts.port);
  console.log('proxying requests to %s', opts.url);
  console.log('caching matches of %s', opts.regex);
  console.log('caching to %s', process.cwd());
}

// store files that are currently in progress -
// if multiple requests are made for the same file, this will ensure that
// only 1 connection is made to the server, and all subsequent requests will
// be queued and then handled after the initial transfer is finished
var inprogress = {};
function onrequest(req, res) {
  accesslog(req, res);

  var _id = uuid.v4();
  function log() {
    if (!opts.debug)
      return;
    var s = util.format.apply(util, arguments);
    return console.error('[%s] %s', _id, s);
  }
  log('INCOMING REQUEST - %s %s', req.method, req.url);

  // parse the URL and determine the filename
  var parsed = url.parse(req.url);
  var file;
  try {
    file = '.' + path.posix.normalize(decodeURIComponent(parsed.pathname));
  } catch (e) {
    log('failed to parse pathname - sending 400 to client -', e.message);
    res.statusCode = 400;
    res.end();
    return;
  }

  // If the request is not a HEAD or GET request, or if it does not match the
  // regex supplied, we simply proxy it without a cache.
  if (CACHE_METHODS.indexOf(req.method) < 0 || ! opts.regex.test(file)) {
    log('request will be proxied with no caching');
    var uristring = opts.url + parsed.path;
    var uri = url.parse(uristring);
    uri.method = req.method;
    uri.headers = {};
    Object.keys(req.headers || {}).forEach(function(header) {
      if (NO_PROXY_HEADERS.indexOf(header) === -1)
        uri.headers[header] = req.headers[header];
    });
    uri.headers.host = uri.host;
    var oreq = http.request(uri, function(ores) {
      res.statusCode = ores.statusCode;
      Object.keys(ores.headers || {}).forEach(function(header) {
        if (NO_PROXY_HEADERS.indexOf(header) === -1)
          res.setHeader(header, ores.headers[header]);
      });
      ores.pipe(res);
    });
    oreq.on('error', function(e) {
      res.statusCode = 500;
      res.end();
    });
    req.pipe(oreq);
    return;
  }

  // check to see if the file exists
  fs.stat(file, function(err, stats) {
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
      streamfile(file, stats, req, res);
      return;
    }

    // another request is already proxying for this file, we wait
    if (hap(inprogress, file)) {
      log('%s download in progress - response queued', file);
      inprogress[file].push([req, res]);
      return;
    }

    // error with stat, proxy it
    inprogress[file] = [];
    var uristring = opts.url + parsed.path;
    var uri = url.parse(uristring);
    uri.method = req.method;
    uri.headers = {};
    Object.keys(req.headers || {}).forEach(function(header) {
      if (NO_PROXY_HEADERS.indexOf(header) === -1)
        uri.headers[header] = req.headers[header];
    });
    uri.headers.host = uri.host;
    log('proxying %s to %s', uri.method, uristring);

    // proxy it
    var oreq = http.request(uri, function(ores) {
      res.statusCode = ores.statusCode;
      Object.keys(ores.headers || {}).forEach(function(header) {
        if (NO_PROXY_HEADERS.indexOf(header) === -1)
          res.setHeader(header, ores.headers[header]);
      });

      if (res.statusCode !== 200) {
        ores.pipe(res);
        finish();
        return;
      }

      mkdirp(path.dirname(file), function(err) {
        var tmp = file + '.in-progress';
        log('saving local file to %s', tmp);
        var ws = fs.createWriteStream(tmp);
        ws.on('finish', function() {
          fs.rename(tmp, file, function(err) {
            if (err) {
              log('failed to rename %s to %s', tmp, file);
              finish();
            } else {
              log('renamed %s to %s', tmp, file);
              finish(file, ores);
            }
          });
        });
        ws.on('error', function(e) {
          log('failed to save local file %s', e.message);
          ores.unpipe(ws);
          finish();
        });
        ores_ws = new clone(ores);
        ores_res = new clone(ores);
        ores_ws.pipe(ws);
        ores_res.pipe(res);
      });
    });
    oreq.on('error', function(e) {
      log('error with proxy request %s', e.message);
      finish();
      res.statusCode = 500;
      res.end();
    });
    oreq.end();
  });
}

// finish queued up requests
function finish(file, ores) {
  if (!file || !ores) {
    inprogress[file].forEach(function(o) {
      var res = o[1];
      res.statusCode = 400;
      res.end();
    });
    delete inprogress[file];
    return;
  }
  fs.stat(file, function(err, stats) {
    if (stats && stats.isDirectory()) {
      // directory, give up
      inprogress[file].forEach(function(o) {
        var res = o[1];
        res.statusCode = 400;
        res.end();
      });
    } else if (stats) {
      // file exists, stream it locally
      inprogress[file].forEach(function(o) {
        var req = o[0];
        var res = o[1];
        res.statusCode = ores.statusCode;
        Object.keys(ores.headers || {}).forEach(function(header) {
          if (NO_PROXY_HEADERS.indexOf(header) === -1)
            res.setHeader(header, ores.headers[header]);
        });
        streamfile(file, stats, req, res);
      });
    } else {
      // not found
      inprogress[file].forEach(function(o) {
        var res = o[1];
        res.statusCode = 500;
        res.end();
      });
    }
    delete inprogress[file];
  });
}

// given a filename and its stats object (and req and res)
// stream it
function streamfile(file, stats, req, res) {
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
  rs.on('error', function(e) {
    res.statusCode = e.code === 'ENOENT' ? 404 : 500;
    res.end();
  });
  res.on('close', rs.destroy.bind(rs));
}
