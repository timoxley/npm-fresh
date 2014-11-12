# npm-fresh

Keep your npm cache fresh.

## Usage

While `npmfresh` is running, npm will not hit the network for any package
which it has already downloaded. Only packages which have been updated
since npm-fresh was started will need to be downloaded.

```
> npmfresh --verbose
following from 594308
saving current cache-min: 60
setting new cache-min
npm config set cache-min 999999999
594310 cleared ltkit@*
594311 cleared coffee-browserify@*
594312 cleared coffee-browserify@*
594313 cleared ltkit@*
594314 cleared ltkit@*
```

## TODO

* Add new versions to cache when found.
* Invalidate specific versions.
* Only log for packages already in the cache.
* Check for updates to packages already in cache in case they were missed by the follower.
* More docs.
* Tests.

## License

MIT
