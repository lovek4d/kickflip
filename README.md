# Kickflip

Kickflip puts your Claude Code sessions' work on your phone. One hub on your host, a Mac or a Linux machine, serves pages over your Tailscale network: a sidebar of every site, and boards that show each session's work as tasks, with the questions waiting on you and a push notification when something needs you. Sessions write to their boards, and you follow and steer them from your phone.

## Install

On a Mac, with [Homebrew](https://brew.sh):

```sh
brew install node git gh
brew install --cask claude-code

npm i -g @lovek4d/kickflip
kickflip init
```

Kickflip needs Node 22 or newer. On Linux, install the same tools with your package manager.

Run `gh auth login` on the host. Tailscale (`brew install --cask tailscale-app`) is only for the tailnet, below.

Optional: tmux, only for `kickflip join --hub` and `kickflip hub` below, and Codex.

`kickflip init` links kickflip into Claude Code and starts the hub as a login service, on this host at `http://127.0.0.1:4500/`. Run `kickflip doctor` any time to see what is set up and what is not.

## Tailnet

The hub serves only the host it runs on until you turn the tailnet on. To reach it from your phone, sign in to Tailscale on the host and the phone, turn on HTTPS certificates for your tailnet, then run:

```
$ kickflip tailnet on
tailnet on: the hub is at https://mac.tailnet-name.ts.net/
```

Open that address on your phone, and add it to your home screen to get push notifications. `kickflip url` prints it again. `kickflip tailnet off` takes the hub off the tailnet, and `kickflip tailnet status` says which it is.

## Add a board

- **From the app:** tap New board and pick a GitHub repo.
- **From a folder:** in a git repo's folder, run `kickflip join`. It asks for a board name and starts the board's Claude Code session in the background.

The hub checks every board's PRs on GitHub in one query, and handles about 50 open PRs at once.

## Run the hub board in tmux (optional)

To have the hub board's session running in a terminal you can attach to, run `kickflip join --hub` in its folder. Later, `kickflip hub` attaches to it, or starts it first. This needs tmux.

## Commands

- `kickflip init`: first-time setup
- `kickflip url`: print the hub's address, the one to open on your phone while the tailnet is on
- `kickflip tailnet on | off | status`: put the hub on your tailnet, take it off, or say which
- `kickflip doctor`: check what is set up, `--fix` repairs it
- `kickflip join`: add this folder as a board
- `kickflip hub`: attach to the hub board's tmux session
- `kickflip sessions`: list each board's session
- `kickflip start <route>` / `resume <route>`: start or resume a board's session
- `kickflip restart [route]` / `logs <route>`: restart a site (the hub with no route) or read its log
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
