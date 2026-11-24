# Security

## Reporting

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/naitsric/itztli/security/advisories/new),
not in an issue.

## What Itztli protects

**A vault is only data.** Opening one, whoever it came from, runs nothing:

- Plugins inside it stay off until you enable them, on this computer and for
  this vault. Consent is for the exact files you saw; if one changes, the
  plugin stops until you review it.
- Notes are sanitized before they are drawn, and the window's content policy
  runs no script that is not the app's or an enabled plugin's.
- Reading a note connects to nothing. Images from the web load only after you
  allow them, in a native dialog.
- Paths are confined to the vault, symlinks included.
- Files are opened with other applications only if their kind just shows
  something; anything that could run is shown in its folder instead.

**What plugins can't give themselves.** An enabled plugin runs in the app's
page and can call its commands, so it can read and change the open vault. It
can't open other folders, enable other plugins, change its own or others' code,
write in hidden folders such as `.git`, or run programs. Those either are not
possible from the page, or are asked in a native dialog.

The window's content policy also keeps plugins from the network, except for the
origins in their manifest, which you see before enabling them.

## What it does not

**The page is not a sandbox.** Plugins share it with the app and with each
other: one can read what another keeps, or use the network access another was
given. The content policy stops loads (requests, images, frames, scripts,
forms, navigation), but WebKit has side channels it does not cover:
`<link rel="preconnect">` still opens a connection, and with it a name is looked
up. Treat the network rule as what keeps honest plugins honest and makes a leak
hard, not impossible.

Enable only plugins you trust, as in any editor. If one keeps the app from
working, start it with `--safe-mode`, or run *Restart in Safe Mode*.

Enabling a plugin *for development* trusts its folder: it runs whatever is there
from then on. Only do it with code you are writing.
