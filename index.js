"use strict"

var spawn = require('child_process').spawn
var exec = require('child_process').exec

var minimist = require('minimist')
var follow = require('follow')
var Configstore = require('configstore')

var SKIMDB = "https://skimdb.npmjs.com/registry"

var packageName = require('./package').name
var conf = new Configstore(packageName, {since: 594192})

var argv = minimist(process.argv, {
  default: {
    cachemin: true,
    silent: false,
    verbose: false
  },
  boolean: ['cachemin']
})

var since = argv.since || conf.get('since')
if (since === 'now') since = -1


if (argv.cachemin) setCacheMin(function(err) {
  if (err) console.error(err) // ignore err
})

if (argv.verbose) console.error('following from %d', since)

var follower = follow({
  db: SKIMDB,
  since: parseInt(since) || 'now',
  inactivity_ms: 1000 * 60 * 60
}, function(err, change) {
  if (err) return console.error(err)
  var pkg = {name: change.id}
  invalidate(pkg, function(err) {
    if (err) return console.error(err)
    if (!argv.silent) console.log('%d cleared %s@%s', change.seq, pkg.name, pkg.version || '*')
    conf.set('since', parseInt(change.seq))
  })
})

process
.on('SIGHUP', shutdown)
.on('SIGINT', shutdown)
.on('SIGQUIT', shutdown)
.on('SIGABRT', shutdown)
.on('SIGTERM', shutdown)

function invalidate(pkg, done) {
  var cmd = 'npm'
  var args = 'cache clean '
  args += pkg.name
  if (pkg.version) args += '@' + version
  args += ' --silent '
  spawn(cmd, args.split(' '), {stdio: 'inherit'})
  .once('error', function(err) {
    console.error(err) // ignore err, whatever
    done(err, pkg)
    done = noop
  })
  .once('exit', function() {
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
  if (!argv.cachemin) return process.exit()
  unsetCacheMin(function(err) {
    if (err) console.error(err) // ignore err
    process.exit()
  })
}

function noop() {}
