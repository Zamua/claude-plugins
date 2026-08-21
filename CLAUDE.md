# claude-plugins

A personal Claude Code plugin marketplace. Each plugin lives in
`plugins/<name>/`, declares itself in `plugins/<name>/.claude-plugin/plugin.json`,
and is registered in the root `.claude-plugin/marketplace.json`.

## Keep the README in sync with the manifest

`.claude-plugin/marketplace.json` is what Claude Code loads. `README.md` is what
a person reads to find out what exists. Adding a plugin to the manifest and not
the README leaves the repo advertising less than it ships, and the omission is
invisible because nothing fails.

So a change that adds, removes, or renames a plugin is not finished until
`README.md` matches. Check it rather than trusting memory:

```
python3 -c "
import json, io
mp = [p['name'] for p in json.load(io.open('.claude-plugin/marketplace.json'))['plugins']]
rd = io.open('README.md').read()
missing = [n for n in mp if f'[{n}]' not in rd]
print('missing from README:', missing or 'none')
"
```

The README entry is one bullet: a bold link to the plugin directory, then what it
does and when to reach for it, in the voice of the entries already there. Keep the
order the same as the manifest, so the two read as one list.

Descriptions live in three places, and they drift: the manifest entry, the
plugin's own `plugin.json`, and the README. The manifest and `plugin.json` should
say the same thing. The README may be shorter and more direct, since it is prose
rather than metadata.
