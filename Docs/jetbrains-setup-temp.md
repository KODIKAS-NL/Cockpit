# Rider and Gateway setup (temporary)

Temporary notes for testing the Cockpit Rider plugin. Delete this file when `Docs/jetbrains.md` exists.
Menu names and download pages change between releases, so check them against what you see.

## What goes where

| Machine | Install | Why |
|---------|---------|-----|
| Mac mini (holds the code and the daemon) | JDK 21 (done: `openjdk@21` from brew), Rider (for local mode) | Builds the plugin and runs it in a test IDE; Rider here is also the "local" test |
| MacBook (the screen you sit at) | JetBrains Toolbox, then Gateway (or JetBrains Client) | The thin client for Remote Development over SSH |

You can test the two modes separately. Local mode needs only Rider on the Mac mini. Split mode needs
Gateway on the MacBook and an SSH login to the Mac mini (the same one Remote-SSH uses today).

## 1. JetBrains Toolbox (both machines, optional but easiest)

1. Download the Toolbox App from <https://www.jetbrains.com/toolbox-app/>.
2. Install it and sign in with a JetBrains account.
3. Toolbox then installs and updates Rider and Gateway for you.

## 2. Rider on the Mac mini

1. In Toolbox, install **Rider** (the stable release; use the same major version as the plugin's target, to be set in Phase C).
2. Rider is free for non-commercial use. Pick that licence on the first start if you have no paid one. Check the current terms on the JetBrains site.
3. Open any folder in Rider once, so it creates its settings, then quit it.

This is the target for `./gradlew runIde` (local mode). The Gradle plugin can also download its own copy of Rider; the installed one only matters for you to try the plugin by hand.

## 3. Gateway on the MacBook (split mode)

1. In Toolbox, install **JetBrains Gateway** (or, in newer releases, use the **Remote Development** entry on the Toolbox/Welcome screen).
2. Make sure `ssh <mac-mini>` works from the MacBook without a password prompt (same SSH config as Remote-SSH).
3. In Gateway: **SSH Connection → New Connection**, enter the Mac mini's host, user and key.
4. Choose **Rider** as the IDE and the project folder on the Mac mini, then **Download IDE and Connect**.
   Gateway installs the Rider backend on the Mac mini by itself and opens the JetBrains Client on the MacBook.
5. The Cockpit plugin has to be installed in the **backend** (and, depending on the plugin model, also in the client). Phase B tells which.

## 4. Check the JDK on the Mac mini

The cask `temurin@21` needs `sudo`, so the formula was installed instead. In a terminal:

```
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"
java -version          # openjdk 21...
```

Add the two `export` lines to `~/.zshrc` if you want them in every terminal. Builds from Claude Code export them per command, so this is only for your own use.

## 5. What to tell me when you are ready

- Rider is installed on the Mac mini (version shown under **Rider → About**).
- Gateway connects from the MacBook to the Mac mini and opens a project (yes/no).
- Anything that asked for a licence or a login that I should know about. Never paste tokens or passwords in the chat.
