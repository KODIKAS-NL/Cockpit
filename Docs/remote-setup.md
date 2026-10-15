# Reaching your sessions from other devices

This is how to keep your code and Claude Code on one always-on Mac and use them from a laptop and a
tablet. A conversation keeps running when you close the lid or lose the connection, and any device
can pick it up again.

Nothing goes through a cloud relay. The laptop connects with Remote-SSH, which is a plain SSH
connection, and the tablet opens code-server in a browser. In both cases the VS Code extension host
runs on the Mac that holds the code, and Cockpit attaches to the daemon there. Over a VPN it is the
same setup, with the VPN carrying the traffic.

Below, the machine that holds the code is called the host, and `host.example.lan` stands for its
name. Replace it with yours. The steps assume a Mac host; the energy settings and launchd parts are
macOS specific.

## 1. The host

**Keep it available**

- In System Settings, Energy: turn on "Prevent automatic sleeping when the display is off" and
  "Start up automatically after a power failure".
- Everything runs in your login session. After a reboot someone has to log in, for example with
  Screen Sharing. For a planned restart, `sudo fdesetup authrestart` skips the FileVault screen once.
- Keep projects outside Desktop, Documents and iCloud Drive, for example in `~/Projects`. Otherwise
  macOS asks for folder access on the host's own screen, where nobody sees the prompt, and Claude is
  blocked.

**Claude Code**

- Install Claude Code for the user that will run everything, and sign in once on the host's own
  screen (Screen Sharing, or at the machine). The login is stored in the keychain, which stays
  locked in a plain SSH session.

**The daemon**

- Run the daemon from the Cockpit Daemon menu bar app (`mac/CockpitDaemon`, see its README) or from
  the launchd agent that **Cockpit Daemon: Install daemon** creates. Use one or the other.
- Turn on Open at login for the app.

**SSH**

- Turn on Remote Login in System Settings, General, Sharing, and allow your own user.
- Give the host a fixed IP address (a DHCP reservation) and a DNS name.

## 2. Laptop: Remote-SSH

1. Install VS Code and Microsoft's Remote - SSH extension.
2. Create a key and put it on the host:
   ```sh
   ssh-keygen -t ed25519
   ssh-copy-id you@host.example.lan
   ```
   If the host only accepts keys, `ssh-copy-id` cannot log in. Add the contents of
   `~/.ssh/id_ed25519.pub` to `~/.ssh/authorized_keys` on the host instead (the folder `~/.ssh` needs
   mode 700 and the file mode 600).
3. Add the host to `~/.ssh/config`:
   ```
   Host host
     HostName host.example.lan
     User you
     IdentityFile ~/.ssh/id_ed25519
     IdentitiesOnly yes
     ServerAliveInterval 30
     ServerAliveCountMax 4
   ```
   If a `Host *` block in that file sets its own `IdentityFile`, it replaces ssh's default key list,
   and the new key is never offered. A host block above it, as here, avoids that. If the key has a
   passphrase, load it once with `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.
4. In VS Code run **Remote-SSH: Connect to Host…**, pick the host and open your project folder. The
   first connection downloads VS Code's server onto the host.
5. In that remote window run **Extensions: Install from VSIX…** and choose the Cockpit `.vsix`. It
   installs on the host, which is where it has to run. Reload the window afterwards.

## 3. Tablet: code-server

On the host:

```sh
brew install code-server
```

Set `~/.config/code-server/config.yaml`:

```yaml
bind-addr: 127.0.0.1:8080
auth: password
password: <a long random password>
cert: false
```

Use `127.0.0.1` if the HTTPS proxy runs on the host itself. If it runs on another machine, bind to
the host's LAN address instead, for example `192.168.1.20:8080`.

```sh
code-server --install-extension cockpit-claude-code-daemon-<version>.vsix
brew services start code-server
```

**HTTPS.** Safari needs HTTPS for the clipboard and for VS Code's webviews, and Cockpit's panel is a
webview. Two ways to get it:

- **A reverse proxy you already run** with a certificate for your domain. Forward the name to
  `http://host:8080`, turn on WebSocket support, pass the original Host header, and force HTTPS. With
  Nginx Proxy Manager that means the "Websockets Support" and "Force SSL" switches. This needs
  nothing on the tablet.
- **Caddy on the host** with its own certificate authority:
  ```
  code.host.example.lan {
      tls internal
      @outside not remote_ip 192.168.0.0/16 10.0.0.0/8 100.64.0.0/10
      respond @outside 403
      reverse_proxy 127.0.0.1:8080
  }
  ```
  Then install Caddy's root certificate on the tablet once: send the `root.crt` from Caddy's data
  directory to it, install it under Settings, General, VPN & Device Management, and turn it on under
  Settings, General, About, Certificate Trust Settings. With Homebrew the file is in
  `/opt/homebrew/var/lib/caddy/pki/authorities/local/`.

Code-server gives a full shell on the host behind one password. Keep it reachable from your own
network and VPN only.

Open the address in Safari, log in, and open the same project folder as on the laptop. "Add to Home
Screen" gives a fullscreen app with fewer Safari shortcuts in the way.

## 4. Check that it works

- Start a conversation on the laptop, then open the same folder on the tablet. The conversation
  should appear and stream live.
- The Cockpit Daemon menu should list that session with two windows attached.
- Neither client should show the "daemon is not running" warning. If one does, its extension is not
  running on the host, or the daemon is not up.

| The menu bar menu | The window, with "2 windows" attached |
|---|---|
| ![The Cockpit Daemon menu bar menu](https://raw.githubusercontent.com/KODIKAS-NL/Cockpit/master/images/menubar.jpg) | ![The Cockpit Daemon window](https://raw.githubusercontent.com/KODIKAS-NL/Cockpit/master/images/daemon-app.jpg) |

## Updating the extension

The laptop's Remote-SSH server and code-server keep separate extension folders. Updating one does not
update the other, so install the new `.vsix` in each, then reload the window or the page. The daemon
needs no restart for a change that only touches the interface.

## Away from home

A VPN such as Tailscale carries the same connections. Point the VPN's DNS at your internal DNS server
so the names resolve. This part has not been tested with this setup.
