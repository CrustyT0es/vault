# Vault (phone app)

The web app behind Vault on the phone, served by GitHub Pages at https://crustyt0es.github.io/vault/, and where Vault on the PC gets its
updates from.

It's only the app itself: the notes, files and keys are in the owner's own Supabase project, behind their sign-in.
Made from `vault/web` in the owner's Jarvis repo by `python -m vault.publish`; don't edit it here. `version.json`
lists every file with its sha256, and both devices check each file against it before using a new version.
