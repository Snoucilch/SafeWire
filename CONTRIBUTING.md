# Contributing

Thanks for helping.

1. Open an issue first for big changes, so we can agree on the approach.
2. Keep every file `--!strict`.
3. Add a test in `tests/run.luau` for any new check or bug fix.
4. Run `luau tests/run.luau` and `stylua src tests examples` before opening a pull request.
5. Add a line to `CHANGELOG.md` under "Unreleased".

Good first issues: new checks (`t.color3`, `t.cframe`, `t.union`), RemoteFunction support with a server timeout, and UnreliableRemoteEvent support.
