# Kickflip

An orchestrator console for Claude Code: a board per project, where Claude orchestrates your work and builders build it in worktrees.

Each project gets a board. You hand it tasks; its Claude session plans them with you, asks the questions only you can answer, starts builders that work in their own worktrees, reviews what they build, and lands it. The board tracks the waits, the reviews, the releases and the Slack threads, so you see what needs you and nothing else. One hub on your machine, a Mac or a Linux box, lists every board in a sidebar and sends a push notification when something waits on you.

## Install

On a Mac, with [Homebrew](https://brew.sh):

```sh
brew install node git gh
brew install --cask claude-code

npm i -g @lovek4d/kickflip
kickflip init
```

Kickflip needs Node 22 or newer. On Linux, install the same tools with your package manager. Run `gh auth login` on the host.

`kickflip init` links kickflip into Claude Code and starts the hub as a login service, on this machine at `http://127.0.0.1:4500/`. Run `kickflip doctor` any time to see what is set up and what is not.

The hub opens only on a signed-in device. Run `kickflip link`, open the address it prints on the device and type the 8-digit PIN; a PIN lasts 60 seconds and signs in one device, and `kickflip link` prints a new one each minute until one is used, then exits. Hub › Devices › Show PIN on a signed-in device shows the same. The page signs in as the eighth digit is typed or pasted. Three wrong PINs block that device until `kickflip unblock` or Unblock in Hub › Devices, which lists the blocked devices. `kickflip devices` lists the signed-in devices, `kickflip unlink` signs one out, and `kickflip sign-out` signs every device out.

## Your first board

- **From the app:** open the hub, tap New, and pick a GitHub repo, another host's git link, or a folder on this Mac, which the board works in place (it offers to make a folder a git repo first).
- **From a folder:** in a git repo's folder, run `kickflip join`. It asks for a board name and starts the board's Claude Code session in the background.

## The loop

1. **Ask.** Give the board a task, or hand over a Claude Code session's objective with `/kickflip handoff`.
2. **Triage and plan.** The board's session reads the task, and where it needs you it asks. Grill and prototype rounds settle what is unclear before anything is built.
3. **Build.** A builder works the task in its own worktree and branch, and reports as it goes.
4. **Review and land.** The session reviews the builder's calls, and the task lands on main or opens a pull request.
5. **Release.** Landed work ships with a release, and the board keeps the record.

## The hub

The hub lists every board, shows which wait on you, and sends pushes only when something does. Pull requests are checked on GitHub, reviewers are tracked on each board, and the board can post to Slack. Hub and board pages are served from your machine, with nothing else exposed.

## Reach it from your phone

Off by default. The hub serves only the machine it runs on until you turn the tailnet on. To reach it from your phone, sign in to [Tailscale](https://tailscale.com) (`brew install --cask tailscale-app`) on the machine and the phone, turn on HTTPS certificates for your tailnet, then run:

```
$ kickflip tailnet on
tailnet on: the hub is at https://mac.tailnet-name.ts.net/
```

Open that address on your phone, and add it to your home screen to get push notifications. `kickflip url` prints it again. `kickflip tailnet off` takes the hub off the tailnet, and `kickflip tailnet status` says which it is.

## Commands

- `kickflip init`: first-time setup
- `kickflip url`: print the hub's address
- `kickflip tailnet on | off | status`: put the hub on your tailnet, take it off, or say which
- `kickflip doctor`: check what is set up, `--fix` repairs it
- `kickflip join`: add this folder as a board
- `kickflip sessions`: list each board's session
- `kickflip start <route>` / `resume <route>`: start or resume a board's session
- `kickflip restart [route]` / `logs <route>`: restart a site (the hub with no route) or read its log
- `kickflip close <route>` / `reopen <route>`: close a board and bring it back
- `kickflip export <route>` / `import <file>`: move a board to another host
- `kickflip notifications`: set push notifications
- `kickflip feedback`: open a GitHub issue form with your versions filled in
- `kickflip update`: install the latest version

Run `kickflip --help` for everything.

For sessions, prerequisites in detail and development from a clone, see [SKILL.md](SKILL.md).

## License

Kickflip is licensed under the [MIT License](LICENSE).

Contributing? See [CONTRIBUTING.md](CONTRIBUTING.md).
