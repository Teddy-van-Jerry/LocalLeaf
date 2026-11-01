<p align="center">
  <img src="./images/icon.png" alt="LocalLeaf Logo" width="128" height="128">
</p>

# LocalLeaf: Local LaTeX Editing yet Synced to Overleaf

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/teddy-van-jerry.localleaf?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=teddy-van-jerry.localleaf)
[![Website](https://img.shields.io/badge/Website-localleaf.wqzhao.org-green)](https://localleaf.wqzhao.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A VS Code extension for a workaround solution to collaborate on LaTeX documents using [Overleaf](https://www.overleaf.com/) while editing them locally.

## Features

- **Two-way sync** with Overleaf projects
- **Real-time collaboration** - see collaborators' cursors
- **Conflict resolution** with visual diff view
- **Auto-sync** on file changes
- **Ignore patterns** support (like `.gitignore`)

> **Status bar items** showing Overleaf account, sync status, real-time collaboration status.
> Also shown on the right in this example includes VS Code's error/warning indicators and LaTeX Workshop's build status.
> ![status bar screenshot](./images/status-bar.png)

## Getting Started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=teddy-van-jerry.localleaf)
2. Run `LocalLeaf: Login` command and enter your Overleaf cookies (see [how to get cookies](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies))
3. Open a folder and run `LocalLeaf: Link Folder to Overleaf Project`
4. Start editing - changes sync automatically!

### Choose a sync folder independently of the workspace

Run `LocalLeaf: Select Sync Folder` and select an existing folder. If it already
contains `.localleaf/settings.json`, LocalLeaf reconnects to that project. Otherwise,
run `LocalLeaf: Link Folder to Overleaf Project` to link the selected folder.

The selection is saved locally for this extension host and restored when VS Code
starts, including when a different workspace or an empty window is open. Sync,
reconnect, ignore patterns, and project settings all use the selected folder. Only
one folder is active per window; switching folders disconnects the previous project
and leaves its link settings intact. `LocalLeaf: Show Sync Status` displays the
active folder. A missing saved folder stops synchronization until you choose an
existing folder or return to workspace-based sync.

Use `LocalLeaf: Use Workspace Folder for Sync` to clear the selection and return to
syncing the first workspace folder. Without an explicit selection, the original
workspace-based behavior remains the default. Unlinking removes the project link
from the active folder, but keeps the folder selection.

In Remote SSH, WSL, and Dev Containers, LocalLeaf runs on the remote extension host.
Select a folder on that host's filesystem. The saved selection is not synced to
other machines. VS Code must remain running in a trusted window for synchronization.

> [!WARNING]
> - Only paste cookies when the server URL is the real Overleaf host (`https://www.overleaf.com`). The extension sends the cookie to whatever URL you enter; avoid lookalike URLs such as `https://www.overleaf.com.attacker.test` or ones that hide another host (e.g., `https://www.overleaf.com@evil.com`).
> - Cookies are stored in VS Code Secret Storage, not in your workspace, but they still grant full account access. Treat them like a password and clear credentials with `LocalLeaf: Logout` if you suspect exposure.

## Commands

| Command | Description |
|---------|-------------|
| `LocalLeaf: Login` | Authenticate with Overleaf |
| `LocalLeaf: Logout` | Clear stored credentials |
| `LocalLeaf: Verify Credentials` | Check if your session is still valid |
| `LocalLeaf: Refresh Cookie` | Re-authenticate without full re-login |
| `LocalLeaf: Link Folder to Overleaf Project` | Connect a local folder to an Overleaf project |
| `LocalLeaf: Select Sync Folder` | Select and remember a sync folder independently of the workspace |
| `LocalLeaf: Use Workspace Folder for Sync` | Clear the selection and sync the first workspace folder |
| `LocalLeaf: Unlink Folder` | Disconnect folder from Overleaf project |
| `LocalLeaf: Sync Now` | Pull remote changes and resolve differences |
| `LocalLeaf: Pull from Overleaf` | Download changes from Overleaf |
| `LocalLeaf: Push to Overleaf` | Review and upload selected saved local changes |
| `LocalLeaf: Show Sync Status` | Display sync status and options to resync/reconnect |
| `LocalLeaf: Edit Ignore Patterns` | Configure files to exclude from sync |
| `LocalLeaf: Clean Ignored Files from Overleaf` | Delete stale remote files matched by `.leafignore`, after confirmation |
| `LocalLeaf: Set Main Document` | Set the main `.tex` file for compilation |
| `LocalLeaf: Configure Settings` | Open extension settings |
| `LocalLeaf: Jump to Collaborator` | Navigate to a collaborator's cursor position |

### Uploading manually

Save your files, connect to Overleaf, and run **LocalLeaf: Push to Overleaf** from the Command Palette, click **Push to Overleaf** in the status bar, or choose **Push local changes to Overleaf** in the sync status menu. Select the changed files to upload and press Enter. Existing selected files are updated with local contents; new files are created. Files excluded by `.leafignore` are skipped, and remote-only files are not deleted.

If a file changes while the selection is open, review it and run the command again. The result reports uploaded and failed files; failures remain eligible for retry.

Project file-tree refreshes use a temporary real-time connection to read a fresh snapshot, since modern Overleaf editor HTML does not include the tree. The editing connection stays open. Snapshot requests are spaced at least five seconds apart, and the tree is read again after file selection so remote replacements are still detected before uploading. HTTP fallback requests retain bounded HTTP 429 retries and respect `Retry-After`.

To control when uploads happen, disable **Localleaf: Auto Sync** in VS Code settings (`localleaf.autoSync: false`). A project's `.localleaf/settings.json` setting `autoSync: false` also disables automatic uploads. Manual push remains available with either setting disabled.

Pull checks the current remote tree and asks how to resolve differing files. **Download All New** applies only to new files; existing conflicts require a separate decision. Unsaved edits and files changed while a prompt is open stop the affected operation. Remote deletion or relocation preserves locally edited and untracked files, with details in the LocalLeaf output panel.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `localleaf.defaultServer` | `https://www.overleaf.com` | Overleaf server URL (for self-hosted instances) |
| `localleaf.autoSync` | `true` | Automatically sync when files change |

## Philosophy

LocalLeaf focuses solely on **local file synchronization** with Overleaf. Unlike browser-based solutions, LocalLeaf:

- **Creates a local replica** of your Overleaf project that you can edit with any tool
- **Does not provide online PDF compilation** - use Overleaf's web interface or local tools for that
- **Works seamlessly with [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop)** for local editing, compilation, and preview

This approach gives you the best of both worlds: Overleaf's collaboration features and your preferred local editing environment.

## Related Projects

This project was inspired by and references [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop), which takes a different approach by providing a more integrated Overleaf experience within VS Code, including online PDF preview and compilation. LocalLeaf instead focuses on maintaining a synchronized local copy of your files, leaving PDF compilation to dedicated tools like LaTeX Workshop or Overleaf's web interface.

## Attribution

The LocalLeaf logo is an original Minecraft-style pixelated design depicting a leaf growing from local ground, inspired by the [Overleaf logo](https://commons.wikimedia.org/wiki/File:Overleaf_Logo.svg). LocalLeaf is not affiliated with or endorsed by Overleaf.

## License

[MIT](LICENSE)
