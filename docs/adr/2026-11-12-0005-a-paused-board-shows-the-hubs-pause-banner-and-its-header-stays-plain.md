# A paused board shows the hub's pause banner, and its header stays plain

While usage is paused the board's header time and refresh arrow keep their normal colour (red stays for a stopped or offline board). The board shows the hub's own `HubUI.pauseBanner` at the top, with Keep going (or Stop, or Resume for Pause hub), its forms posting to the hub's `/_hub/settings/` endpoints. Pause board has no hub form, so it shows no banner and the header title says it.
