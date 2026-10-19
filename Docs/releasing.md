# Releasing

Cockpit is published twice: the Visual Studio Marketplace (VS Code) and Open VSX (code-server,
VSCodium, Cursor). Both take the same `.vsix`.

Publisher / namespace: `KODIKAS-NL`. Extension ID: `KODIKAS-NL.cockpit-claude-code-daemon`
(it cannot change after the first publish).

## Each release

1. Make sure the work is committed and the tests pass (`npm test`).
2. Build. This type-checks, bumps the patch version and writes the `.vsix`:
   ```
   npm run vsix
   ```
3. Commit the version bump and push:
   ```
   git add -u && git commit -m "Release <version>" && git push origin master
   ```
4. Publish. The tokens go in the environment of your own terminal, never in a file or in chat:
   ```
   read -s "VSCE_PAT?Marketplace token: " && export VSCE_PAT && echo   # Azure DevOps token, scope Marketplace > Manage
   npm run publish:marketplace

   read -s "OVSX_PAT?Open VSX token: " && export OVSX_PAT && echo      # Open VSX token
   npm run publish:openvsx
   ```
   The `"NAME?Prompt: "` form is zsh (the macOS default); in bash use `read -sp "Prompt: " NAME`.
   Both scripts publish the file for the version in `package.json`.
5. The listings can take a few minutes to appear (the Marketplace verifies the package first).

## Tokens

- **Marketplace:** an Azure DevOps personal access token for the `kodikas-nl` organization, scope
  Marketplace > Manage, at most one year. Check it with `npx vsce verify-pat KODIKAS-NL`.
  `vsce login` can fail while saving the token to the macOS Keychain; the `VSCE_PAT` variable
  avoids that.
- **Open VSX:** a token from the profile settings on open-vsx.org. The Eclipse Publisher Agreement
  must be signed on the linked Eclipse account.
- Revoke a token you no longer need; a closed terminal forgets the variable, the token stays valid.

## The daemon

The package ships `dist/daemon.js`, not the macOS app. Rebuild and install the app separately when
the daemon side changed.
