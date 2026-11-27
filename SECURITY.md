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

**What programs outside can do.** The MCP server is off until you turn it on,
and listens on `127.0.0.1` only. It refuses web pages (any `Origin`) and hosts
that are not this computer, and every request needs the token of a client you
created; only its hash is kept. A client sees the vaults you gave it, only
while they are open, and in them only notes: no attachments, no hidden folders.
A change waits for you, with the difference in front, and is made on exactly
what you saw or not at all; unless you let that client change notes without
asking, and then it is made at once, only where it may write. Every call is
recorded, and the log tells changes you approved from those nobody was asked
about.

Turning the server on, giving a client access to a vault, making it a new token
and letting it change notes without asking are asked in a native dialog, so a
plugin can't do it for you. No tool lets a client change what it may do.

## What it does not

**An assistant can be misled, and can tell.** What a client reads goes wherever
its program sends it. A note may hold text written to steer an assistant; its
tools tell it not to follow it, which is no guarantee. Look at what a change
does, not only at the reason given for it.

**Approving is not out of a plugin's reach.** The dialog that approves a
client's change is drawn in the page plugins share, so an enabled plugin could
answer it, or read a new client's token as it is shown. It gains nothing it
lacks: it can already read and change the same notes by itself.

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
