# A page in the reader sheet clears the app bar

On a phone the reader sheet sits on the bottom edge, above the app bar (`--app-bottom`). The card-page sheet's height was
`100dvh` minus the status-bar inset, ignoring `--app-bottom` and `--vh`, so in the home-screen app its top (title and
close) was pushed off the screen. Its height and max-height now use the same terms as `.sheet`'s max-height:
`var(--vh, 100dvh) - var(--app-bottom, 0px) - max(12px, env(safe-area-inset-top))`.
