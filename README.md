# Kickflip

Kickflip puts your Claude Code sessions' work on your phone. One hub on your host, a Mac or a Linux machine, serves pages over your Tailscale network: a sidebar of every site, and boards that show each session's work as cards, with the questions waiting on you and a push notification when something needs you. Sessions write to their boards, and you follow and steer them from your phone.

## Install

On a Mac, with [Homebrew](https://brew.sh):

```sh
brew install node git gh
brew install --cask tailscale-app claude-code

npm i -g @lovek4d/kickflip
kickflip init
```

Kickflip needs Node 22 or newer. On Linux, install the same tools with your package manager.

Sign in to Tailscale and turn on HTTPS certificates for your tailnet. Run `gh auth login`. Do both on the host, and put Tailscale on your phone too.

Optional: tmux, only for `kickflip join --hub` and `kickflip hub` below, and Codex.

`kickflip init` links kickflip into Claude Code, starts the hub as a login service and serves it over Tailscale. Run `kickflip doctor` any time to see what is set up and what is not.

## Open on your phone

Run `kickflip url`. Open the address it prints.

```
$ kickflip url
https://mac.tailnet-name.ts.net/
```

Add it to your home screen to get push notifications.

## Add a board

- **From the app:** tap New board and pick a GitHub repo.
- **From a folder:** in a git repo's folder, run `kickflip join`. It asks for a board name and starts the board's Claude Code session in the background.

The hub checks every board's PRs on GitHub in one query, and handles about 50 open PRs at once.

## Run the hub board in tmux (optional)

To have the hub board's session running in a terminal you can attach to, run `kickflip join --hub` in its folder. Later, `kickflip hub` attaches to it, or starts it first. This needs tmux.

## Commands

- `kickflip init`: first-time setup
- `kickflip url`: print the address to open on your phone
- `kickflip doctor`: check what is set up, `--fix` repairs it
- `kickflip join`: add this folder as a board
- `kickflip hub`: attach to the hub board's tmux session
- `kickflip sessions`: list each board's session
- `kickflip start <route>` / `resume <route>`: start or resume a board's session
- `kickflip restart <route>` / `logs <route>`: restart a site or read its log
- `kickflip close <route>` / `reopen <route>`: close a board and bring it back
- `kickflip export <route>` / `import <file>`: move a board to another host
- `kickflip notifications`: set push notifications
- `kickflip update`: install the latest version

Run `kickflip --help` for everything.

For sessions, prerequisites in detail and development from a clone, see [SKILL.md](SKILL.md).

## License

Kickflip is licensed under the [Prosperity Public License 3.0.0](LICENSE).

- **Free for noncommercial use:** personal use, hobby projects, study and research, and use by charities, schools and government.
- **Companies** get a 30-day trial. After that, using kickflip for work needs a commercial license from Love Kharod; reach Love at love@kickflip.sh.
- **Ever** (https://www.evercars.com) holds a free commercial license with no end date.

Contributing? See [CONTRIBUTING.md](CONTRIBUTING.md).
