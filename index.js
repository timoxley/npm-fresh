#!/usr/bin/env node

"use strict"

var spawn = require('child_process').spawn
var exec = require('child_process').exec
var request = require('request')
var bl = require('bl')
var fs = require('fs')
var parallel = require('parallel-transform')
var through = require('through2')
var untildify = require('untildify')

var minimist = require('minimist')
var follow = require('follow')
var Configstore = require('configstore')
var map = require('map-limit')

var SKIMDB = "https://skimdb.npmjs.com/registry/"
var NPM_REGISTRY = "https://registry.npmjs.org"

var packageName = require('./package').name
var conf = new Configstore(packageName, {since: 594192})

var argv = minimist(process.argv, {
  default: {
    cachemin: true,
    silent: false,
    verbose: false,
    update: true
  },
  boolean: ['cachemin']
})

var since = argv.since || conf.get('since')
if (since === 'now') since = -1


if (argv.cachemin) setCacheMin(function(err) {
  if (err) console.error(err) // ignore err
})

if (argv.verbose) console.error('following from %d', since)


var queue = parallel(20, function(pkg, done) {
  var self = this
  pkg.name = pkg.change.id
  pkg.seq = pkg.change.seq
  if (argv.verbose) console.log('%d started: %s', pkg.seq, pkg.name)
  var version = pkg['dist-tags'] && pkg['dist-tags'].latest
  if (!pkg['dist-tags']) {
    // handle deprecation
    return has(pkg, null, function(err, hasPackage) {
      if (err) return done(err, pkg)
      if (!hasPackage) return done(err, pkg)
      invalidate(pkg, function(err) {
        if (err) return done(err, pkg)
        if (!argv.silent) console.log('%d invalidated %s@%s', pkg.seq, pkg.name, pkg.version || '*')
        return done(null, pkg)
      })
    })
  }

  pkg.version = version
  pkg.tarball = pkg.versions[version].dist.tarball
  has(pkg, null, function(err, hasPackage) {
    if (err) return done(err, pkg)
    if (!hasPackage) return done(err, pkg)
    add(pkg, function(err, added) {
      if (err) return done(err, pkg)
      if (!argv.silent) console.log('%d added %s@%s', pkg.seq, pkg.name, pkg.version || '*')
      return done(null, pkg)
    })
  })
}).on('error', function(err, pkg) {
  console.error('error', pkg.seq, err)
})

queue.pipe(through.obj(function(pkg, enc, done) {
  if (argv.verbose) console.log('%d finished: %s', pkg.seq, pkg.name)
  conf.set('since', parseInt(pkg.seq))
  done()
}))

if (argv.update) {
  updateCache(function(err) {
    if (err) throw err
    startFollowing()
  })
} else {
  startFollowing()
}

function inspect(item) { // for debugging
  console.log(require('util').inspect(item, {colors: true, depth: 30}))
}

function updateCache(fn) {
  if (argv.verbose) console.error('updating cache')
  exec('npm cache ls --silent | grep "/package/package\.json$"', function(err, stdout) {
    if (err) return fn(err)
    var lines = stdout.trim().split('\n').map(function(line) {return untildify(line.trim())})
    map(lines, Infinity, function(line, next) {
      fs.readFile(line, 'utf8', function(err, data) {
        if (err) return next(err);
        var pkgJSON = JSON.parse(data)
        pkgJSON._resolved && pkgJSON._resolved.indexOf(NPM_REGISTRY) === 0
        ? next(null, pkgJSON)
        : next()
      })
    }, function(err, packages) {
      if (err) return fn(err)
      packages = packages || []
      packages = packages.filter(Boolean)
      map(packages, 10, function(pkg, next) {
        request.get({
          url: SKIMDB + pkg.name,
          json: true,
          headers: {
            'user-agent': packageName
          }
        }, function(err, response, pkgData) {
          if (err) return console.error(err), next();
          if (!pkgData) return next()
          pkgData.change = {
            id: pkg.name,
            seq: -1
          }
          queue.write(pkgData)
          next(null)
        })
      }, function(err) {
        if (argv.verbose) console.error('queued cache updates.')
        fn(err)
      })
    })
  })
}

function startFollowing() {
  var follower = follow({
    db: SKIMDB,
    since: parseInt(since) || 'now',
    inactivity_ms: 1000 * 60 * 60
  }, function(err, change) {
    if (err) return console.error(err)
    request.get({
      url: SKIMDB + change.id,
      json: true,
      headers: {
        'user-agent': packageName
      }
    }, function(err, response, pkgData) {
      if (err) return console.error(err)
      if (!pkgData) return
      pkgData.change = change
      queue.write(pkgData)
    })
  })
}


process
.on('SIGHUP', shutdown)
.on('SIGINT', shutdown)
.on('SIGQUIT', shutdown)
.on('SIGABRT', shutdown)
.on('SIGTERM', shutdown)

function add(pkg, done) {
  if (argv.verbose) console.error('%d adding %s@%s', pkg.seq, pkg.name, pkg.version || '*')
  var tarball = pkg.tarball
  var cmd = 'npm'
  var args = 'cache add '
  args += pkg.name
  args += '@' + pkg.version
  args += ' --silent '
  spawn(cmd, args.split(' '))
  .once('error', function(err) {
    done(err, tarball)
    done = noop
  })
  .once('close', function() {
    done(null, tarball)
    done = noop
  })
}

function has(pkg, version, done) {
  var cmd = 'npm'
  var args = 'cache ls '
  args += pkg.name
  if (version != null) args += '@' + version
  args += ' --silent '
  var hasPackage = null
  var hasClosed = null
  var hasError = null
  spawn(cmd, args.split(' '))
  .once('error', function(err) {
    done(err)
    done = noop
  })
  .once('close', function() {
    hasClosed = true
    if (hasPackage !== null) {
      done(null, hasPackage)
      done = noop
    }
  }).stdout.pipe(bl(function(err, stdout) {
    if (err) return done(err)
    hasPackage = stdout && stdout.length && !!String(stdout).trim().length
    if (argv.verbose && hasPackage) {
      console.error('%d cache has %s@%s', pkg.seq, pkg.name, version || '*')
    }
    if (hasClosed !== null) {
      done(null, hasPackage)
      done = noop
    }
  }))
}


function invalidate(pkg, done) {
  if (argv.verbose) console.error('%d invalidating %s', pkg.seq, pkg.name)
  var cmd = 'npm'
  var args = 'cache clean '
  args += pkg.name
  if (pkg.version) args += '@' + version
  args += ' --silent '
  spawn(cmd, args.split(' '))
  .once('error', function(err) {
    console.error(pkg.seq, err) // ignore err, whatever
    done(err, pkg)
    done = noop
  })
  .once('close', function() {
    done(null, pkg)
    done = noop
  })
}

function setCacheMin(done) {
  exec('npm config get cache-min', function(err, stdout) {
    if (err) return done(err)
    var cacheMin = parseInt(stdout.trim())
    if (argv.verbose) console.error('saving current cache-min: %d', cacheMin)
    // save old cache-min
    conf.set('cache-min', cacheMin)
    if (argv.verbose) console.error('setting new cache-min')
    if (argv.verbose) console.error('npm config set cache-min 999999999')
    exec('npm --silent config set cache-min 999999999', done)
  })
}

function unsetCacheMin(done) {
  var cacheMin = conf.get('cache-min')
  // restore old cache-min
  if (argv.verbose) {
    console.error('restoring old cache-min: %d', cacheMin)
    console.error('npm config set cache-min ' + cacheMin)
  }
  exec('npm --silent config set cache-min ' + cacheMin, done)
}

function shutdown() {
  if (argv.verbose) console.error('\nshutting down...')
  queue.end()
  if (!argv.cachemin) return process.exit()
  unsetCacheMin(function(err) {
    if (err) console.error(err) // ignore err
    process.exit()
  })
}

function noop() {}
